// Instrument search — redesigned to fit Cloudflare's FREE plan on two axes:
//
// 1. CPU time (10ms/invocation): we never parse the entire multi-MB instrument
//    dump into objects in one request. We cache the RAW CSV text as-is (cheap —
//    just a network fetch + one KV write, no parsing at all) and only parse the
//    handful of lines that match a search, using a cheap substring pre-check on
//    the raw line text before ever calling .split(','). A wall-clock time guard
//    aborts the scan early (returning partial results) rather than risking a
//    hard CPU-limit kill.
// 2. KV writes (1,000/day on the free plan): refreshing the cache is exactly
//    3 KV writes (raw NSE text, raw NFO text, a timestamp) — regardless of how
//    many instruments exist. No per-instrument or per-chunk writes.
//
// Kite's /instruments/:exchange dump is reference data (symbols, lot sizes,
// expiries) — not live market data — so it's expected to work on Kite's free
// "Personal API" tier. Its `last_price` column is a once-daily snapshot, not a
// live quote; we surface it labeled as "Reference price" rather than "LTP".

const COL = { instrument_token: 0, exchange_token: 1, tradingsymbol: 2, name: 3, last_price: 4, expiry: 5, strike: 6, tick_size: 7, lot_size: 8, instrument_type: 9, segment: 10, exchange: 11 };
const SCAN_MS_BUDGET = 6; // leave headroom under the ~10ms/request free-plan CPU cap

function scanLines(csv, matches, onMatch, maxMs = SCAN_MS_BUDGET) {
  const t0 = Date.now();
  const len = csv.length;
  let pos = 0, i = 0, truncated = false;
  while (pos < len) {
    if ((++i & 511) === 0 && (Date.now() - t0) > maxMs) { truncated = true; break; }
    const nl = csv.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let line = csv.slice(pos, lineEnd);
    pos = nl === -1 ? len : nl + 1;
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // trailing \r
    if (line && matches(line)) onMatch(line);
  }
  return { truncated };
}

export async function refreshRawCache(env, kite) {
  const [nse, nfo] = await Promise.all([
    kite.getInstrumentsCSV('NSE'),
    kite.getInstrumentsCSV('NFO')
  ]);
  await env.KITE_DATA.put('instr:raw:NSE', nse);
  await env.KITE_DATA.put('instr:raw:NFO', nfo);
  await env.KITE_DATA.put('instr:raw:updated_at', new Date().toISOString());
  return { nseBytes: nse.length, nfoBytes: nfo.length };
}

export async function searchInstruments(env, query, kite) {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return { error: 'Type at least 2 characters' };

  const [nseRaw, nfoRaw, updatedAt] = await Promise.all([
    env.KITE_DATA.get('instr:raw:NSE'),
    env.KITE_DATA.get('instr:raw:NFO'),
    env.KITE_DATA.get('instr:raw:updated_at')
  ]);
  if (!nseRaw && !nfoRaw) {
    return { error: 'Instrument list not loaded yet. Go to Setup and click "Refresh Instrument List Now".' };
  }

  const equity = [];
  if (nseRaw) {
    scanLines(nseRaw, line => line.includes(q), line => {
      if (equity.length >= 8) return;
      const c = line.split(',');
      if (c[COL.instrument_type] !== 'EQ') return;
      equity.push({ tradingsymbol: c[COL.tradingsymbol], name: c[COL.name], exchange: 'NSE', lot_size: 1, ref_price: parseFloat(c[COL.last_price]) || null });
    });
  }

  let futures = [], optionExpiries = [], underlyingName = null;
  if (nfoRaw) {
    const collected = [];
    const nameCounts = new Map();
    scanLines(nfoRaw, line => line.includes(q), line => {
      collected.push(line);
      const name = line.split(',', 4)[3];
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    });

    underlyingName = [...nameCounts.keys()].find(n => n === q)
      || [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      || null;

    if (underlyingName) {
      for (const line of collected) {
        const c = line.split(',');
        if (c[COL.name] !== underlyingName) continue;
        const itype = c[COL.instrument_type];
        if (itype === 'FUT') {
          futures.push({ tradingsymbol: c[COL.tradingsymbol], exchange: c[COL.exchange], expiry: c[COL.expiry], lot_size: parseInt(c[COL.lot_size]) || 1, ref_price: parseFloat(c[COL.last_price]) || null });
        } else if (itype === 'CE' || itype === 'PE') {
          const exp = c[COL.expiry];
          if (!optionExpiries.includes(exp)) optionExpiries.push(exp);
        }
      }
      futures.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
      futures = futures.slice(0, 4);
      optionExpiries.sort((a, b) => new Date(a) - new Date(b));
      optionExpiries = optionExpiries.slice(0, 6);
    }
  }

  return { equity, futures, optionExpiries, underlyingName, lastUpdated: updatedAt || null };
}

export async function getOptionChain(env, name, expiry) {
  const nfoRaw = await env.KITE_DATA.get('instr:raw:NFO');
  if (!nfoRaw) return [];
  const nameUpper = name.trim().toUpperCase();
  const byStrike = {};
  scanLines(nfoRaw, line => line.includes(nameUpper) && line.includes(expiry), line => {
    const c = line.split(',');
    if (c[COL.name] !== nameUpper || c[COL.expiry] !== expiry) return;
    const itype = c[COL.instrument_type];
    if (itype !== 'CE' && itype !== 'PE') return;
    const strike = parseFloat(c[COL.strike]) || 0;
    if (!byStrike[strike]) byStrike[strike] = { strike, lot_size: parseInt(c[COL.lot_size]) || 1, ce: null, pe: null };
    const info = { tradingsymbol: c[COL.tradingsymbol], exchange: c[COL.exchange], ref_price: parseFloat(c[COL.last_price]) || null };
    if (itype === 'CE') byStrike[strike].ce = info; else byStrike[strike].pe = info;
  }, 8); // option chain scans are narrower (name+expiry both must match) — a touch more budget is safe
  return Object.values(byStrike).sort((a, b) => a.strike - b.strike);
}
