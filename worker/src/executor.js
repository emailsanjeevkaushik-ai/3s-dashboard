import { KiteClient, TokenExpiredError } from './kite.js';
import { sendTelegram, fmtOrder } from './notify.js';

// IST = UTC + 5:30
function getIST(timestamp) {
  const utc = new Date(timestamp || Date.now());
  const ist = new Date(utc.getTime() + 5.5 * 60 * 60 * 1000);
  const hh = ist.getUTCHours();
  const mm = ist.getUTCMinutes();
  return {
    date: ist.toISOString().split('T')[0],
    time: `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`,
    totalMinutes: hh * 60 + mm,
    dayOfWeek: ist.getUTCDay(),  // 0=Sun 6=Sat
    ist
  };
}

function isWeekday(ist)     { return ist.dayOfWeek >= 1 && ist.dayOfWeek <= 5; }
function isMarketOpen(ist)  { return isWeekday(ist) && ist.totalMinutes >= 9*60 && ist.totalMinutes <= 15*60+35; }

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
      if (!isMarketOpen(ist)) return false;
      const key = `${instr.exchange}:${instr.tradingsymbol}`;
      const q = await kite.getQuote([key]);
      if (q.status !== 'success' || !q.data?.[key]) return false;
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

  return { exit_order_id: exitRes.data.order_id, entry_order_id: entryRes.data.order_id };
}

async function execPriceTrigger(instr, kite) {
  return execScheduledOrder(instr, kite); // Same order placement logic
}

class PartialError extends Error {
  constructor(msg, exitOrderId) { super(msg); this.name = 'PartialError'; this.exitOrderId = exitOrderId; }
}

// ──────────────────────────────────────────────
// Main cron handler
// ──────────────────────────────────────────────
export async function runInstructions(env, scheduledTime) {
  const ist = getIST(scheduledTime);

  const cfg = await env.KITE_DATA.get('config:kite', 'json');
  if (!cfg?.apiKey || !cfg?.accessToken) return;

  const notify = await env.KITE_DATA.get('config:notify', 'json') || {};

  // Daily 08:30 IST reminder to refresh access token
  if (ist.time === '08:30' && isWeekday(ist)) {
    await sendTelegram(notify.telegramBotToken, notify.telegramChatId,
      '⏰ <b>3S Dashboard</b>: Refresh your Kite access token for today\'s trading session.');
  }

  const ids = await env.KITE_DATA.get('instructions:list', 'json') || [];
  if (!ids.length) return;

  const kite = new KiteClient(cfg.apiKey, cfg.accessToken);

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
