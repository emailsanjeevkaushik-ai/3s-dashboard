# 3S Kite Executor — Cloudflare Worker

Autonomous order execution backend for 3S Dashboard. Runs a cron every minute to check and execute pending instructions via Kite Connect API.

## Features

- **Futures rollover** — automatically squares off current month and enters next month
- **Scheduled orders** — place any order at a specific date and time (IST)
- **Price triggers** — place order when LTP crosses a threshold
- **Telegram notifications** — alerts on execution, failure, token expiry
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

## Important Notes

- **Access token expires daily** — update it each morning via the KITE button in the dashboard. The worker sends a Telegram reminder at 8:30 AM IST.
- **Rollover partial execution** — if exit succeeds but entry fails, you get a Telegram alert to manually enter the next month position.
- **Cron runs every minute** — Cloudflare free plan allows 100k cron invocations/day.
- **Market hours check** — price triggers only fire during 9:00–15:35 IST Mon–Fri. Scheduled orders fire when date+time is reached.
