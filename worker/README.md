# 3S Kite Executor — Cloudflare Worker

Autonomous order execution backend for 3S Dashboard. Runs a cron every minute to check and execute pending instructions via Kite Connect API.

This system is designed to run on **entirely free tiers** — Cloudflare Workers free plan, Cloudflare KV free plan, and Kite Connect's free "Personal API". See **What You Can and Cannot Do**, below, for the one real trade-off that comes with staying free.

## What You Can and Cannot Do (Free Tier)

Two separate services have free tiers here, and each has its own limit:

| Service | Free limit | What it constrains |
|---|---|---|
| Cloudflare Workers | 10ms CPU time per request/cron tick | How much computation one invocation can do |
| Cloudflare KV | 100,000 reads/day, **1,000 writes/day**, 1GB storage | How much data you can store/update per day |
| Kite Connect "Personal API" | Free forever, but **no live market data** | Whether you can check live prices |

**✅ Fully free, no restrictions:**
- Scheduled Orders (place any order at a specific date/time)
- Futures Rollover (exit current month, enter next month, at a scheduled time)
- Stop-Loss & Target attachment (two-leg OCO GTT placed automatically once your entry order fills — uses the order's own fill price, not a live quote, so it doesn't need Kite's paid plan)
- Ticker search (stock / futures / option lookup, lot sizes) — the instrument list is cached as raw text and only scanned for lines matching your search, so refreshing it is 3 small writes/day, and search itself does no writes at all
- Kite Portfolio holdings/positions sync (dashboard's KITE button) — holdings/positions/funds are part of Kite's free tier
- Telegram notifications, execution history, pause/resume/delete instructions

**❌ Cannot work without Kite's paid Connect plan (₹500/month, from Zerodha — nothing to do with Cloudflare):**
- **Price Trigger instructions** — these require checking the live price every minute, and Kite's free Personal API does not include live market data at all (not even a single LTP). If you create a Price Trigger without the paid plan, it will show a repeating error in Telegram/history instead of silently doing nothing. Scheduled Order and Futures Rollover cover the "act at a certain time" case without needing this.
- **Live price display in the ticker picker** — you'll see a "Ref ₹X" price next to each symbol you search, which comes from a once-daily snapshot baked into Kite's instrument list dump, not a live quote. It can be stale by up to a day. This is clearly labeled as "Ref" rather than "LTP" in the UI so it's never mistaken for a live price.

**⚠️ Soft limits worth knowing (very unlikely to hit under normal personal use):**
- KV allows 1,000 writes/day. Instrument refresh uses 3. Each instruction status change or history entry is 1-2 writes. Even running 20-30 active instructions with frequent retries in a day stays well under 1,000 — but if you were to create hundreds of instructions with very frequent price-trigger-style polling, you could approach it. There's no way to pay Cloudflare to raise this on the same free KV namespace — you'd need a paid KV plan.
- The 10ms CPU limit is why ticker search never parses the whole instrument file — it does a cheap substring scan with a time-budget cutoff (returns partial results rather than erroring if a search is unusually broad). Searches with fewer than 2 characters are rejected client-side and server-side to keep every scan bounded.

## Features

- **Futures rollover** — automatically squares off current month and enters next month
- **Scheduled orders** — place any order at a specific date and time (IST)
- **Price triggers** — place order when LTP crosses a threshold (requires Kite's paid plan — see above)
- **Ticker search** — type a symbol in the dashboard and see the stock, its futures, and its options, with lot sizes — no more typing exact Kite contract symbols by hand
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

Both `wrangler.toml` and this deployment target Cloudflare's **free** Workers plan — nothing here requires upgrading. If you already have a Cloudflare account with billing set up for something else, double check you're not on a plan that bills per-request; the free plan (100k requests/day) is what this is built for.

### 4. Configure in Dashboard

1. Open 3S Dashboard → click **AUTOMATE**
2. Go to **Setup** tab
3. Enter your worker URL and set a password
4. Click **SAVE & INITIALIZE**
5. Click **REFRESH INSTRUMENT LIST NOW** once — this loads the stock/futures/options database that powers ticker search (cheap, ~2 seconds, just downloads and caches Kite's symbol list)

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
| GET | `/instruments/search?q=` | Search a ticker → matching stock, futures (with expiries), option expiries. Requires 2+ characters. |
| GET | `/instruments/options?name=&expiry=` | Option chain (strikes + CE/PE tradingsymbols) for one underlying/expiry |
| POST | `/instruments/refresh` | Re-download and cache Kite's instrument list (cheap — no parsing happens here) |

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

### Price Trigger (requires Kite's paid Connect plan — see above)
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
is auto-cancelled, and vice versa. This uses the order's own average fill price as the
GTT reference price, not a live quote — so it works on Kite's free plan.
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
- **Cron runs every minute** — Cloudflare free plan allows 100k cron invocations/day, far more than the 1,440/day this uses.
- **Market hours check** — price triggers only fire during 9:00–15:35 IST Mon–Fri. Scheduled orders fire when date+time is reached.
- **Futures price vs underlying** — futures/options are always looked up as their own instrument, distinct from the underlying stock/index — the picker never conflates a future's data with the spot symbol's.
- **Instrument search is a cheap scan, not a live database** — see "What You Can and Cannot Do" above for exactly why this stays within Cloudflare's free CPU and KV-write limits.
- **GTT SL/Target ordering** — verified against Kite's official two-leg OCO examples: `trigger_values` must be ascending `[lower, upper]`, and `orders[i]` must match `trigger_values[i]`. The worker sorts this automatically regardless of which price (SL or Target) is higher. Test with a small quantity first before relying on this for real trades — Kite's API details can change.
