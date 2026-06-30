const TG_BASE = 'https://api.telegram.org';

export async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`${TG_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[notify] Telegram error:', e.message);
  }
}

export function fmtOrder(label, params) {
  return [
    `<b>${label}</b>`,
    `Symbol: <code>${params.tradingsymbol}</code> [${params.exchange}]`,
    `Side: <b>${params.transaction_type}</b>  Qty: ${params.quantity}`,
    `Type: ${params.order_type}  Product: ${params.product}`,
    params.price ? `Price: ₹${params.price}` : ''
  ].filter(Boolean).join('\n');
}
