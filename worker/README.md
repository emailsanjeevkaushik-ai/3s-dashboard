# 3S Kite Executor — Cloudflare Worker

Autonomous order execution backend for 3S Dashboard. Runs a cron every minute to check and execute pending instructions via Kite Connect API.

## Features

- **Futures rollover** — automatically squares off current month and enters next month
- **Scheduled orders** — place any order at a specific date and time (IST)
- **Price triggers** — place order when LTP crosses a threshold
- **Ticker search** — type a symbol in the dashboard and see the stock, its futures, and its options (with lot size and live/last-close price) — no more typing exact Kite contract symbols by hand
- **Stop-Loss & Target attachment** — after a scheduled order or price-triggered order FILLS, the worker automatically places a two-leg OCO GTT (Stop-Loss + Target — one cancels the other)
- **Telegram notifications** — alerts on execution, failure, fills, token expiry
- **Kite API proxy** — solves browser CORS for the dashboard

## Deployment

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace

```bash
cd worker
npm install
npx wrangler kv:namespace create KITE_DATA
# Copy the id shown and paste into wrangler.toml

npx wrangler kv:namespace create KITE_DATA --preview
# Copy the preview_id into wrangler.toml
```

### 3. Deploy

```bash
npm run deploy
# Your worker URL: https://3s-kite-executor.YOUR_ACCOUNT.workers.dev
```

### 4. Configure in Dashboard

1. Open 3S Dashboard → click **AUTOMATE**
2. Go to **Setup** tab
3. Enter your worker URL and set a password
4. Click **SAVE & INITIALIZE**
5. Click **REFRESH INSTRUMENT LIST NOW** once — this loads the stock/futures/options database that powers ticker search (see CPU limit warning below)

## API Reference

All endpoints (except `/` and `/setup`) require header `X-Auth-Token: <your-password>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/setup` | First-time password setup |
| POST | `/auth/kite` | Update Kite credentials |
| GET/POST | `/config/notify` | Telegram config |
| ANY | `/kite/*` | Proxy to Kite API |
| GET | `/instructions` | List all instructions |
| POST | `/instructions` | Create instruction |
| PUT | `/instructions/:id` | Update instruction |
| DELETE | `/instructions/:id` | Delete instruction |
| POST | `/instructions/:id/pause` | Pause instruction |
| POST | `/instructions/:id/resume` | Resume instruction |
| GET | `/history` | Execution history |
| POST | `/run-now` | Manually trigger cron |
| GET | `/instruments/search?q=` | Search a ticker → matching stock, futures (with expiries), option expiries, and spot price |
| GET | `/instruments/options?name=&expiry=` | Option chain (strikes + CE/PE tradingsymbols) for one underlying/expiry |
| POST | `/instruments/refresh` | Rebuild the instrument cache from Kite's daily dump (heavy — see CPU note below) |
| GET | `/quotes?i=EXCHANGE:SYMBOL` (repeatable) | Batch LTP + previous close + market-open flag |

## Instruction Schemas

### Futures Rollover
```json
{
  "type": "futures_rollover",
  "label": "NIFTY June Rollover",
  "direction": "LONG",
  "exchange": "NFO",
  "current_symbol": "NIFTY24JUNFUT",
  "next_symbol": "NIFTY24JULFUT",
  "quantity": 50,
  "product": "NRML",
  "execute_date": "2024-06-27",
  "execute_time": "15:15"
}
```

### Scheduled Order
```json
{
  "type": "scheduled_order",
  "label": "Buy RELIANCE at open",
  "tradingsymbol": "RELIANCE",
  "exchange": "NSE",
  "transaction_type": "BUY",
  "order_type": "MARKET",
  "quantity": 10,
  "product": "CNC",
  "execute_date": "2024-06-28",
  "execute_time": "09:15",
  "variety": "regular"
}
```

### Price Trigger
```json
{
  "type": "price_trigger",
  "label": "Buy NIFTY breakout",
  "tradingsymbol": "NIFTY24JUNFUT",
  "exchange": "NFO",
  "condition": "crosses_above",
  "trigger_price": 23500,
  "transaction_type": "BUY",
  "order_type": "MARKET",
  "quantity": 50,
  "product": "NRML",
  "max_retries": 3
}
```

### Scheduled Order / Price Trigger with Stop-Loss & Target attachment
Add `attach_sl_tgt` to either type. Once the entry order status becomes `COMPLETE`,
the worker places a two-leg (OCO) GTT: if price hits the Stop-Loss, the Target order
is auto-cancelled, and vice versa.
```json
{
  "type": "scheduled_order",
  "label": "Buy RELIANCE with SL/Target",
  "tradingsymbol": "RELIANCE",
  "exchange": "NSE",
  "transaction_type": "BUY",
  "order_type": "MARKET",
  "quantity": 10,
  "product": "CNC",
  "execute_date": "2024-06-28",
  "execute_time": "09:15",
  "variety": "regular",
  "attach_sl_tgt": { "enabled": true, "sl_price": 2850, "target_price": 3000 }
}
```
While waiting for the entry to fill, the instruction's status is `awaiting_fill`. If the
entry order is rejected/cancelled it becomes `entry_failed`. If it sits unfilled for more
than 60 minutes, polling stops and the status becomes `fill_timeout` (check Kite manually
— the order may still fill later, just without an attached SL/Target).

## Important Notes

- **Access token expires daily** — update it each morning via the KITE button in the dashboard. The worker sends a Telegram reminder at 8:30 AM IST.
- **Rollover partial execution** — if exit succeeds but entry fails, you get a Telegram alert to manually enter the next month position.
- **Cron runs every minute** — Cloudflare free plan allows 100k cron invocations/day.
- **Market hours check** — price triggers only fire during 9:00–15:35 IST Mon–Fri. Scheduled orders fire when date+time is reached.
- **Futures price vs underlying** — the ticker picker always fetches quotes for the *exact* instrument you selected (`EXCHANGE:TRADINGSYMBOL`). A future's LTP shown in the dashboard is the future contract's own price, never the spot/underlying price — they're fetched and displayed as separate instruments.
- **Instrument list & CPU limits** — Kite's instrument dump has tens of thousands of rows. Parsing it on Cloudflare's **free** Workers plan (≈10ms CPU/request) will likely fail. The **Workers Paid plan ($5/mo)** raises this to 30s CPU/invocation and is recommended for reliable daily refreshes. This only affects the instrument-list refresh — order placement, polling, and everything else is cheap and works fine on the free plan.
- **GTT SL/Target ordering** — verified against Kite's official two-leg OCO examples: `trigger_values` must be ascending `[lower, upper]`, and `orders[i]` must match `trigger_values[i]`. The worker sorts this automatically regardless of which price (SL or Target) is higher. Test with a small quantity first before relying on this for real trades — Kite's API details can change.
