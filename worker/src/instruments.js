// Instrument master caching + search.
//
// IMPORTANT: Kite's NFO instrument dump has tens of thousands of rows.
// Parsing it costs real CPU time. On Cloudflare's FREE plan, a single
// request/cron invocation is capped at ~10ms CPU — parsing the full dump
// will likely exceed that and fail. The Workers PAID plan ($5/mo) raises
// this to 30s CPU per invocation, which is required for reliable refresh.
// This only affects the daily instrument-list refresh, not order placement
// or day-to-day polling, which are cheap.

const CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // refresh if older than 20h

// Minimal columns kept, to keep the KV value size down.
// Raw CSV header: instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
function parseInstrumentsCSV(csv, filterFn) {
  const out = [];
  let start = 0;
  const len = csv.length;
  let headerSkipped = false;
  let fieldIdx = {};

  // Single-pass line split (Kite's dump has no embedded newlines/commas in quotes for our needed columns)
  let lineStart = 0;
  for (let i = 0; i <= len; i++) {
    if (i === len || csv[i] === '\n') {
      let line = csv.slice(lineStart, i);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lineStart = i + 1;
      if (!line) continue;

      if (!headerSkipped) {
        const cols = line.split(',');
        cols.forEach((c, idx) => { fieldIdx[c] = idx; });
        headerSkipped = true;
        continue;
      }

      const cols = line.split(',');
      const row = {
        tradingsymbol: cols[fieldIdx.tradingsymbol],
        name: cols[fieldIdx.name],
        expiry: cols[fieldIdx.expiry] || null,
        strike: parseFloat(cols[fieldIdx.strike]) || 0,
        lot_size: parseInt(cols[fieldIdx.lot_size]) || 1,
        instrument_type: cols[fieldIdx.instrument_type],
        segment: cols[fieldIdx.segment],
        exchange: cols[fieldIdx.exchange],
        instrument_token: cols[fieldIdx.instrument_token]
      };
      if (!filterFn || filterFn(row)) out.push(row);
    }
  }
  return out;
}

export async function refreshInstrumentCache(env, kite) {
  // NSE equity — keep only EQ instrument_type to stay small
  const nseCsv = await kite.getInstrumentsCSV('NSE');
  const nseEq = parseInstrumentsCSV(nseCsv, r => r.instrument_type === 'EQ');
  await env.KITE_DATA.put('instr:NSE_EQ', JSON.stringify(nseEq));

  // NFO — futures + options for all underlyings
  const nfoCsv = await kite.getInstrumentsCSV('NFO');
  const nfo = parseInstrumentsCSV(nfoCsv, r => r.instrument_type === 'FUT' || r.instrument_type === 'CE' || r.instrument_type === 'PE');
  await env.KITE_DATA.put('instr:NFO', JSON.stringify(nfo));

  await env.KITE_DATA.put('instr:updated_at', new Date().toISOString());
  return { nseEqCount: nseEq.length, nfoCount: nfo.length };
}

export async function ensureFreshCache(env, kite) {
  const updatedAt = await env.KITE_DATA.get('instr:updated_at');
  if (updatedAt && (Date.now() - new Date(updatedAt).getTime()) < CACHE_MAX_AGE_MS) {
    return { refreshed: false };
  }
  const result = await refreshInstrumentCache(env, kite);
  return { refreshed: true, ...result };
}

export async function searchInstruments(env, query, kite) {
  const q = query.trim().toUpperCase();
  if (!q) return { equity: [], futures: [], optionExpiries: [], spot: null };

  const nseEq = await env.KITE_DATA.get('instr:NSE_EQ', 'json') || [];
  const nfo = await env.KITE_DATA.get('instr:NFO', 'json') || [];

  const equity = nseEq
    .filter(r => r.tradingsymbol.includes(q) || r.name.toUpperCase().includes(q))
    .slice(0, 8)
    .map(r => ({ tradingsymbol: r.tradingsymbol, name: r.name, exchange: 'NSE', lot_size: 1 }));

  // Match futures/options by underlying name — Kite's `name` column on NFO
  // rows holds the underlying (e.g. "RELIANCE", "NIFTY"), not the contract symbol.
  const underlyingMatches = nfo.filter(r => r.name.toUpperCase().includes(q) || r.tradingsymbol.startsWith(q));

  const futures = underlyingMatches
    .filter(r => r.instrument_type === 'FUT')
    .sort((a, b) => new Date(a.expiry) - new Date(b.expiry))
    .slice(0, 4)
    .map(r => ({ tradingsymbol: r.tradingsymbol, exchange: r.exchange, expiry: r.expiry, lot_size: r.lot_size }));

  const optionExpiries = [...new Set(
    underlyingMatches.filter(r => r.instrument_type === 'CE' || r.instrument_type === 'PE').map(r => r.expiry)
  )].sort((a, b) => new Date(a) - new Date(b)).slice(0, 6);

  // Underlying name for options (needed by the /instruments/options lookup)
  const underlyingName = underlyingMatches[0]?.name || (equity[0]?.name) || q;

  // Fetch spot LTP if we have a clean equity or index match, so the frontend
  // can center an option strike ladder without a second round trip.
  let spot = null;
  const spotKey = equity[0] ? `NSE:${equity[0].tradingsymbol}` : null;
  if (spotKey && kite) {
    try {
      const qres = await kite.getQuote([spotKey]);
      if (qres.status === 'success' && qres.data?.[spotKey]) {
        spot = { last_price: qres.data[spotKey].last_price, close: qres.data[spotKey].ohlc?.close };
      }
    } catch { /* best-effort */ }
  }

  return { equity, futures, optionExpiries, underlyingName, spot };
}

export async function getOptionChain(env, name, expiry) {
  const nfo = await env.KITE_DATA.get('instr:NFO', 'json') || [];
  const nameUpper = name.trim().toUpperCase();
  const matches = nfo.filter(r =>
    r.name.toUpperCase() === nameUpper && r.expiry === expiry && (r.instrument_type === 'CE' || r.instrument_type === 'PE')
  );

  const byStrike = {};
  for (const r of matches) {
    if (!byStrike[r.strike]) byStrike[r.strike] = { strike: r.strike, lot_size: r.lot_size, ce: null, pe: null };
    if (r.instrument_type === 'CE') byStrike[r.strike].ce = { tradingsymbol: r.tradingsymbol, exchange: r.exchange };
    else byStrike[r.strike].pe = { tradingsymbol: r.tradingsymbol, exchange: r.exchange };
  }
  return Object.values(byStrike).sort((a, b) => a.strike - b.strike);
}
