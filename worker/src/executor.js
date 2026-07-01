import { KiteClient, TokenExpiredError } from './kite.js';
import { sendTelegram, fmtOrder } from './notify.js';
import { getIST, isWeekday, isMarketOpen } from './ist.js';

const FILL_POLL_TIMEOUT_MIN = 60; // give up polling for a fill after this many minutes

// ──────────────────────────────────────────────
// Condition checkers
// ──────────────────────────────────────────────
async function shouldExecute(instr, ist, kite) {
  switch (instr.type) {
    case 'scheduled_order':
      // Fire once when date+time is reached
      return isWeekday(ist) && ist.date >= instr.execute_date && ist.time >= instr.execute_time;

    case 'futures_rollover':
      // Only during market hours on the rollover date
      return isMarketOpen(ist) && ist.date === instr.execute_date && ist.time >= instr.execute_time;

    case 'price_trigger': {
      // NOTE: this requires live market data, which needs Kite's paid Connect
      // plan (₹500/mo) — the free "Personal API" tier does not include quotes.
      // We surface that as a loud, retried error rather than silently never
      // firing, so it's obvious in Telegram/history why nothing is happening.
      if (!isMarketOpen(ist)) return false;
      const key = `${instr.exchange}:${instr.tradingsymbol}`;
      const q = await kite.getQuote([key]);
      if (q.status !== 'success') {
        throw new Error('Live quote fetch failed (' + (q.message || 'no data access') + ') — Price Trigger requires Kite\'s paid Connect plan for market data.');
      }
      if (!q.data?.[key]) return false;
      const ltp = q.data[key].last_price;
      const prev = instr._last_ltp ?? ltp;
      // Persist last ltp for cross detection (stored on instr in KV by caller)
      instr._last_ltp = ltp;
      switch (instr.condition) {
        case 'gte':           return ltp >= instr.trigger_price;
        case 'lte':           return ltp <= instr.trigger_price;
        case 'crosses_above': return prev < instr.trigger_price && ltp >= instr.trigger_price;
        case 'crosses_below': return prev > instr.trigger_price && ltp <= instr.trigger_price;
        default: return false;
      }
    }

    default: return false;
  }
}

// ──────────────────────────────────────────────
// Order executors
// ──────────────────────────────────────────────
async function execScheduledOrder(instr, kite) {
  const result = await kite.placeOrder(instr.variety || 'regular', {
    tradingsymbol:    instr.tradingsymbol,
    exchange:         instr.exchange,
    transaction_type: instr.transaction_type,
    order_type:       instr.order_type,
    quantity:         instr.quantity,
    product:          instr.product,
    price:            instr.price || 0,
    trigger_price:    instr.trigger_price || 0,
    validity:         'DAY'
  });
  if (result.status !== 'success') throw new Error(result.message || 'Order rejected');

  if (instr.attach_sl_tgt?.enabled) {
    return { order_id: result.data.order_id, awaiting_fill: true };
  }
  return { order_id: result.data.order_id };
}

async function execFuturesRollover(instr, kite) {
  const exitSide  = instr.direction === 'LONG' ? 'SELL' : 'BUY';
  const entrySide = instr.direction === 'LONG' ? 'BUY'  : 'SELL';
  const base = { exchange: instr.exchange, order_type: 'MARKET', product: instr.product, quantity: instr.quantity, validity: 'DAY', price: 0 };

  // Step 1 — exit current month
  const exitRes = await kite.placeOrder('regular', { ...base, tradingsymbol: instr.current_symbol, transaction_type: exitSide, tag: '3sd_rollover_exit' });
  if (exitRes.status !== 'success') throw new Error(`Exit failed: ${exitRes.message}`);

  // 1-second gap between legs
  await new Promise(r => setTimeout(r, 1000));

  // Step 2 — enter next month
  const entryRes = await kite.placeOrder('regular', { ...base, tradingsymbol: instr.next_symbol, transaction_type: entrySide, tag: '3sd_rollover_entry' });
  if (entryRes.status !== 'success') {
    // Exit succeeded but entry failed — alert partial execution
    throw new PartialError(`Exit order placed (${exitRes.data.order_id}) but entry FAILED: ${entryRes.message}`, exitRes.data.order_id);
  }

  if (instr.attach_sl_tgt?.enabled) {
    return { exit_order_id: exitRes.data.order_id, order_id: entryRes.data.order_id, awaiting_fill: true };
  }
  return { exit_order_id: exitRes.data.order_id, entry_order_id: entryRes.data.order_id };
}

async function execPriceTrigger(instr, kite) {
  return execScheduledOrder(instr, kite); // Same order placement logic
}

class PartialError extends Error {
  constructor(msg, exitOrderId) { super(msg); this.name = 'PartialError'; this.exitOrderId = exitOrderId; }
}

// ──────────────────────────────────────────────
// SL / Target GTT attachment (fires after entry order fills)
// ──────────────────────────────────────────────
// Kite two-leg (OCO) GTT convention, confirmed against Kite's official examples:
//   trigger_values must be ascending [lower, upper], and orders[i] price === trigger_values[i].
//   For a LONG entry (BUY), the exit leg is SELL: SL sits below LTP (lower), Target sits above (upper).
//   For a SHORT entry (SELL), the exit leg is BUY: Target sits below LTP (lower), SL sits above (upper).
function buildSlTgtGtt({ exchange, tradingsymbol, quantity, product, entryTxn, slPrice, targetPrice, lastPrice }) {
  const exitTxn = entryTxn === 'BUY' ? 'SELL' : 'BUY';
  const lower = Math.min(slPrice, targetPrice);
  const upper = Math.max(slPrice, targetPrice);
  const leg = (price) => ({ exchange, tradingsymbol, transaction_type: exitTxn, quantity, order_type: 'LIMIT', product, price });
  return {
    type: 'two-leg',
    condition: { exchange, tradingsymbol, trigger_values: [lower, upper], last_price: lastPrice },
    orders: [leg(lower), leg(upper)]
  };
}

async function checkAwaitingFills(env, kite, notify) {
  const ids = await env.KITE_DATA.get('instructions:list', 'json') || [];
  if (!ids.length) return;

  let ordersCache = null; // fetch Kite's order list once per cron tick, not per-instruction

  for (const id of ids) {
    const instr = await env.KITE_DATA.get(`instruction:${id}`, 'json');
    if (!instr || instr.status !== 'awaiting_fill') continue;

    try {
      if (!ordersCache) {
        const resp = await kite.getOrders();
        if (resp.status !== 'success') throw new Error(resp.message || 'Could not fetch orders');
        ordersCache = resp.data;
      }

      const order = ordersCache.filter(o => o.order_id === instr.entry_order_id)
        .sort((a, b) => new Date(b.order_timestamp) - new Date(a.order_timestamp))[0];
      if (!order) continue; // order not visible yet, try again next minute

      if (order.status === 'COMPLETE') {
        // Use the order's own fill price as the GTT reference price — avoids
        // needing a live quote, which requires Kite's paid data plan. The
        // free "Personal API" tier covers orders/GTT but not market data.
        const lastPrice = order.average_price || instr.price || 0;

        const gttPayload = buildSlTgtGtt({
          exchange: instr.exchange,
          tradingsymbol: instr.tradingsymbol,
          quantity: instr.quantity,
          product: instr.product,
          entryTxn: instr.transaction_type,
          slPrice: instr.attach_sl_tgt.sl_price,
          targetPrice: instr.attach_sl_tgt.target_price,
          lastPrice
        });
        const gttRes = await kite.placeGTT(gttPayload.type, gttPayload.condition, gttPayload.orders);
        if (gttRes.status !== 'success') throw new Error('Entry filled but GTT SL/Target failed: ' + (gttRes.message || 'unknown error'));

        await setStatus(env, instr, 'executed', {
          entry_fill_price: order.average_price,
          gtt_id: gttRes.data.trigger_id,
          executed_at: new Date().toISOString()
        });
        await appendHistory(env, id, true, { order_id: instr.entry_order_id, gtt_id: gttRes.data.trigger_id, sl: instr.attach_sl_tgt.sl_price, target: instr.attach_sl_tgt.target_price });
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `✅ <b>${instr.label}</b> filled @ ₹${order.average_price}\nSL/Target GTT attached — SL ₹${instr.attach_sl_tgt.sl_price} / Target ₹${instr.attach_sl_tgt.target_price}`);

      } else if (order.status === 'REJECTED' || order.status === 'CANCELLED') {
        await setStatus(env, instr, 'entry_failed', { last_error: order.status_message || order.status });
        await appendHistory(env, id, false, { order_id: instr.entry_order_id, status: order.status });
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `❌ <b>${instr.label}</b> entry order ${order.status.toLowerCase()} — no SL/Target attached.\n${order.status_message || ''}`);

      } else {
        // Still OPEN / TRIGGER PENDING — check for polling timeout
        const startedAt = new Date(instr.fill_poll_started_at || instr.created_at).getTime();
        const ageMin = (Date.now() - startedAt) / 60000;
        if (ageMin > FILL_POLL_TIMEOUT_MIN) {
          await setStatus(env, instr, 'fill_timeout', { last_error: `Order still ${order.status} after ${FILL_POLL_TIMEOUT_MIN} min — stopped auto-polling` });
          await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
            `⚠️ <b>${instr.label}</b> hasn't filled after ${FILL_POLL_TIMEOUT_MIN} min (still ${order.status}). Stopped watching — check Kite manually. SL/Target was NOT attached.`);
        }
      }
    } catch (e) {
      if (e instanceof TokenExpiredError) throw e; // let caller handle globally
      await setStatus(env, instr, 'entry_failed', { last_error: e.message });
      await appendHistory(env, id, false, { error: e.message });
      await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
        `❌ <b>${instr.label}</b> error while attaching SL/Target: ${e.message}`);
    }
  }
}

// ──────────────────────────────────────────────
// Main cron handler
// ──────────────────────────────────────────────
export async function runInstructions(env, scheduledTime) {
  const ist = getIST(scheduledTime);

  const cfg = await env.KITE_DATA.get('config:kite', 'json');
  if (!cfg?.apiKey || !cfg?.accessToken) return;

  const notify = await env.KITE_DATA.get('config:notify', 'json') || {};
  const kite = new KiteClient(cfg.apiKey, cfg.accessToken);

  // Daily 08:30 IST reminder to refresh access token
  if (ist.time === '08:30' && isWeekday(ist)) {
    await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
      '⏰ <b>3S Dashboard</b>: Refresh your Kite access token for today\'s trading session.');
  }

  try {
    await checkAwaitingFills(env, kite, notify);
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
        '🔑 <b>Kite token expired</b> — update your access token in 3S Dashboard to resume.');
      return;
    }
  }

  const ids = await env.KITE_DATA.get('instructions:list', 'json') || [];
  if (!ids.length) return;

  for (const id of ids) {
    const instr = await env.KITE_DATA.get(`instruction:${id}`, 'json');
    if (!instr || instr.status !== 'active') continue;

    try {
      const fire = await shouldExecute(instr, ist, kite);

      // Save updated _last_ltp for price triggers even if not firing
      if (instr.type === 'price_trigger') {
        await env.KITE_DATA.put(`instruction:${id}`, JSON.stringify(instr));
      }

      if (!fire) continue;

      let result;
      switch (instr.type) {
        case 'scheduled_order':  result = await execScheduledOrder(instr, kite); break;
        case 'futures_rollover': result = await execFuturesRollover(instr, kite); break;
        case 'price_trigger':    result = await execPriceTrigger(instr, kite); break;
      }

      if (result.awaiting_fill) {
        await setStatus(env, instr, 'awaiting_fill', { entry_order_id: result.order_id, fill_poll_started_at: new Date().toISOString() });
        await appendHistory(env, id, true, { order_id: result.order_id, note: 'Entry placed — watching for fill to attach SL/Target' });
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `⏳ <b>${instr.label}</b> entry order placed (#${result.order_id}) — watching for fill to attach SL/Target.`);
        continue;
      }

      await setStatus(env, instr, 'executed', { result, executed_at: new Date().toISOString() });
      await appendHistory(env, id, true, result);

      await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
        `✅ <b>Executed: ${instr.label || instr.type}</b>\n${JSON.stringify(result)}`);

    } catch (e) {
      if (e instanceof TokenExpiredError) {
        // Don't retry — token needs manual refresh
        await setStatus(env, instr, 'token_expired', { last_error: e.message });
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `🔑 <b>Kite token expired</b> — update your access token in 3S Dashboard to resume:\n${instr.label || id}`);
        break; // All instructions will fail with same token — stop loop
      }

      if (e instanceof PartialError) {
        await setStatus(env, instr, 'partial', { last_error: e.message, exit_order_id: e.exitOrderId });
        await appendHistory(env, id, false, { error: e.message });
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `⚠️ <b>Partial execution: ${instr.label}</b>\n${e.message}\n<b>Action required: manually enter next month position.</b>`);
        continue;
      }

      const retries = (instr.retries || 0) + 1;
      const maxRetries = instr.max_retries || 3;
      const newStatus = retries >= maxRetries ? 'failed' : 'active';
      await setStatus(env, instr, newStatus, { retries, last_error: e.message, last_attempt: new Date().toISOString() });
      await appendHistory(env, id, false, { error: e.message, attempt: retries });

      if (newStatus === 'failed') {
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `❌ <b>FAILED: ${instr.label || instr.type}</b>\nMax retries (${maxRetries}) reached.\nError: ${e.message}`);
      } else {
        await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
          `⚠️ <b>Retry ${retries}/${maxRetries}: ${instr.label}</b>\n${e.message}`);
      }
    }
  }
}

async function setStatus(env, instr, status, extra = {}) {
  await env.KITE_DATA.put(`instruction:${instr.id}`, JSON.stringify({ ...instr, status, ...extra }));
}

async function appendHistory(env, instrId, success, data) {
  const history = await env.KITE_DATA.get('history:list', 'json') || [];
  history.unshift({ instrId, success, data, at: new Date().toISOString() });
  if (history.length > 200) history.splice(200);
  await env.KITE_DATA.put('history:list', JSON.stringify(history));
}
