import { KiteClient } from './kite.js';
import { runInstructions } from './executor.js';
import { searchInstruments, getOptionChain, ensureFreshCache, refreshInstrumentCache } from './instruments.js';
import { getIST, isMarketOpen } from './ist.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function authed(request, env) {
  const token = request.headers.get('X-Auth-Token');
  const stored = await env.KITE_DATA.get('auth:token');
  return stored && token === stored;
}

async function getKite(env) {
  const cfg = await env.KITE_DATA.get('config:kite', 'json');
  if (!cfg?.apiKey || !cfg?.accessToken) return null;
  return new KiteClient(cfg.apiKey, cfg.accessToken);
}

export default {
  // ── HTTP handler ──────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── First-time setup (no auth required) ──
    if (path === '/setup' && method === 'POST') {
      const { password } = await request.json();
      if (!password) return json({ error: 'password required' }, 400);
      const existing = await env.KITE_DATA.get('auth:token');
      if (existing) return json({ error: 'Already set up. Use /reset to change password.' }, 403);
      await env.KITE_DATA.put('auth:token', password);
      return json({ ok: true });
    }

    // Status / health (no auth)
    if (path === '/' && method === 'GET') {
      const hasAuth = !!(await env.KITE_DATA.get('auth:token'));
      const hasCreds = !!(await env.KITE_DATA.get('config:kite', 'json'))?.apiKey;
      return json({ service: '3s-kite-executor', setup: hasAuth, kite_configured: hasCreds });
    }

    // All other routes require auth
    if (!(await authed(request, env))) return json({ error: 'Unauthorized' }, 401);

    // ── Kite credentials ──
    if (path === '/auth/kite' && method === 'POST') {
      const { apiKey, accessToken } = await request.json();
      if (!apiKey || !accessToken) return json({ error: 'apiKey and accessToken required' }, 400);
      await env.KITE_DATA.put('config:kite', JSON.stringify({ apiKey, accessToken, updatedAt: new Date().toISOString() }));
      // Clear any token_expired status on active instructions
      const ids = await env.KITE_DATA.get('instructions:list', 'json') || [];
      for (const id of ids) {
        const instr = await env.KITE_DATA.get(`instruction:${id}`, 'json');
        if (instr?.status === 'token_expired') {
          await env.KITE_DATA.put(`instruction:${id}`, JSON.stringify({ ...instr, status: 'active', last_error: null }));
        }
      }
      return json({ ok: true });
    }

    // ── Notification config ──
    if (path === '/config/notify' && method === 'GET') {
      return json(await env.KITE_DATA.get('config:notify', 'json') || {});
    }
    if (path === '/config/notify' && method === 'POST') {
      await env.KITE_DATA.put('config:notify', JSON.stringify(await request.json()));
      return json({ ok: true });
    }

    // ── Kite API proxy (solves browser CORS) ──
    if (path.startsWith('/kite/')) {
      const kite = await getKite(env);
      if (!kite) return json({ error: 'Kite credentials not configured' }, 400);

      const kitePath = path.slice(5); // strip /kite prefix
      let result;

      if (method === 'GET') {
        result = await kite.get(kitePath, Object.fromEntries(url.searchParams));
      } else if (method === 'POST') {
        const body = await request.json();
        result = await kite.post(kitePath, body);
      } else if (method === 'PUT') {
        const body = await request.json();
        result = await kite.put(kitePath, body);
      } else if (method === 'DELETE') {
        result = await kite.del(kitePath);
      }

      return json(result);
    }

    // ── Instrument search (stock / futures / option expiries for a ticker) ──
    if (path === '/instruments/search' && method === 'GET') {
      const kite = await getKite(env);
      const q = url.searchParams.get('q') || '';
      const cacheAge = await env.KITE_DATA.get('instr:updated_at');
      if (!cacheAge) return json({ error: 'Instrument list not loaded yet — go to Setup and click "Refresh Instrument List" first.' }, 400);
      const result = await searchInstruments(env, q, kite);
      return json(result);
    }

    // ── Option chain for a specific underlying + expiry ──
    if (path === '/instruments/options' && method === 'GET') {
      const name = url.searchParams.get('name');
      const expiry = url.searchParams.get('expiry');
      if (!name || !expiry) return json({ error: 'name and expiry required' }, 400);
      const chain = await getOptionChain(env, name, expiry);
      return json({ chain });
    }

    // ── Manually (re)build the instrument cache — heavy op, run from Setup tab ──
    if (path === '/instruments/refresh' && method === 'POST') {
      const kite = await getKite(env);
      if (!kite) return json({ error: 'Kite credentials not configured' }, 400);
      try {
        const result = await refreshInstrumentCache(env, kite);
        return json({ ok: true, ...result });
      } catch (e) {
        return json({ error: 'Refresh failed (may exceed CPU limit on free Workers plan): ' + e.message }, 500);
      }
    }

    // ── Batch quotes — used by the symbol picker for live LTP / last close ──
    if (path === '/quotes' && method === 'GET') {
      const kite = await getKite(env);
      if (!kite) return json({ error: 'Kite credentials not configured' }, 400);
      const instruments = url.searchParams.getAll('i');
      if (!instruments.length) return json({ error: 'at least one ?i= instrument key required' }, 400);
      const q = await kite.getQuote(instruments);
      if (q.status !== 'success') return json({ error: q.message || 'Quote fetch failed' }, 502);
      const marketOpen = isMarketOpen(getIST());
      const out = {};
      for (const key of instruments) {
        const d = q.data?.[key];
        if (!d) continue;
        out[key] = { last_price: d.last_price, close: d.ohlc?.close, market_open: marketOpen };
      }
      return json(out);
    }

    // ── Instructions CRUD ──
    if (path === '/instructions' && method === 'GET') {
      const ids = await env.KITE_DATA.get('instructions:list', 'json') || [];
      const items = await Promise.all(ids.map(id => env.KITE_DATA.get(`instruction:${id}`, 'json')));
      return json(items.filter(Boolean));
    }

    if (path === '/instructions' && method === 'POST') {
      const body = await request.json();
      if (!body.type || !body.label) return json({ error: 'type and label required' }, 400);
      const id = uid();
      const instr = { ...body, id, status: 'active', retries: 0, created_at: new Date().toISOString() };
      const ids = await env.KITE_DATA.get('instructions:list', 'json') || [];
      ids.push(id);
      await Promise.all([
        env.KITE_DATA.put(`instruction:${id}`, JSON.stringify(instr)),
        env.KITE_DATA.put('instructions:list', JSON.stringify(ids))
      ]);
      return json(instr, 201);
    }

    const instrMatch = path.match(/^\/instructions\/([\w]+)$/);
    if (instrMatch) {
      const id = instrMatch[1];
      const existing = await env.KITE_DATA.get(`instruction:${id}`, 'json');
      if (!existing) return json({ error: 'Not found' }, 404);

      if (method === 'GET') return json(existing);

      if (method === 'PUT') {
        const updated = { ...existing, ...await request.json(), id };
        await env.KITE_DATA.put(`instruction:${id}`, JSON.stringify(updated));
        return json(updated);
      }

      if (method === 'DELETE') {
        const ids = (await env.KITE_DATA.get('instructions:list', 'json') || []).filter(i => i !== id);
        await Promise.all([
          env.KITE_DATA.delete(`instruction:${id}`),
          env.KITE_DATA.put('instructions:list', JSON.stringify(ids))
        ]);
        return json({ ok: true });
      }
    }

    // Pause/resume shortcut
    if (path.match(/^\/instructions\/[\w]+\/(pause|resume)$/) && method === 'POST') {
      const [,, id, action] = path.split('/');
      const instr = await env.KITE_DATA.get(`instruction:${id}`, 'json');
      if (!instr) return json({ error: 'Not found' }, 404);
      const status = action === 'pause' ? 'paused' : 'active';
      const updated = { ...instr, status };
      await env.KITE_DATA.put(`instruction:${id}`, JSON.stringify(updated));
      return json(updated);
    }

    // ── Execution history ──
    if (path === '/history' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const history = (await env.KITE_DATA.get('history:list', 'json') || []).slice(0, limit);
      return json(history);
    }

    // ── Manual trigger for testing ──
    if (path === '/run-now' && method === 'POST') {
      // Run synchronously so we can return the result
      await runInstructions(env, Date.now());
      return json({ ok: true, message: 'Instructions checked and executed if conditions met' });
    }

    return json({ error: 'Not found' }, 404);
  },

  // ── Cron handler (every minute) ──────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runInstructions(env, event.scheduledTime));

    // Keep instrument cache fresh — only actually refreshes once per day
    // (cheap KV read short-circuits the rest on every other tick), and only
    // during a quiet pre-market window so a slow parse doesn't collide with
    // order-execution ticks.
    const ist = getIST(event.scheduledTime);
    if (ist.time >= '07:30' && ist.time <= '07:40') {
      ctx.waitUntil((async () => {
        const cfg = await env.KITE_DATA.get('config:kite', 'json');
        if (!cfg?.apiKey || !cfg?.accessToken) return;
        const kite = new KiteClient(cfg.apiKey, cfg.accessToken);
        try { await ensureFreshCache(env, kite); } catch (e) { console.error('[cron] instrument refresh failed:', e.message); }
      })());
    }
  }
};
