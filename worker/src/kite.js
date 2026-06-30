const KITE_BASE = 'https://api.kite.trade';

export class TokenExpiredError extends Error {
  constructor(msg) { super(msg); this.name = 'TokenExpiredError'; }
}

export class KiteClient {
  constructor(apiKey, accessToken) {
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.authHeader = `token ${apiKey}:${accessToken}`;
  }

  _headers(contentType) {
    return {
      'Authorization': this.authHeader,
      'X-Kite-Version': '3',
      ...(contentType ? { 'Content-Type': contentType } : {})
    };
  }

  async _parse(resp) {
    const data = await resp.json();
    if (data.error_type === 'TokenException') throw new TokenExpiredError(data.message);
    return data;
  }

  async get(path, query) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const resp = await fetch(KITE_BASE + path + qs, { headers: this._headers() });
    return this._parse(resp);
  }

  async post(path, params) {
    const resp = await fetch(KITE_BASE + path, {
      method: 'POST',
      headers: this._headers('application/x-www-form-urlencoded'),
      body: new URLSearchParams(params).toString()
    });
    return this._parse(resp);
  }

  async put(path, params) {
    const resp = await fetch(KITE_BASE + path, {
      method: 'PUT',
      headers: this._headers('application/x-www-form-urlencoded'),
      body: new URLSearchParams(params).toString()
    });
    return this._parse(resp);
  }

  async del(path) {
    const resp = await fetch(KITE_BASE + path, { method: 'DELETE', headers: this._headers() });
    return this._parse(resp);
  }

  async placeOrder(variety, params) {
    return this.post(`/orders/${variety}`, { ...params, tag: '3sdashboard' });
  }

  async cancelOrder(variety, orderId) {
    return this.del(`/orders/${variety}/${orderId}`);
  }

  async getQuote(instruments) {
    const qs = instruments.map(i => ['i', i]);
    const resp = await fetch(KITE_BASE + '/quote?' + new URLSearchParams(qs), { headers: this._headers() });
    return this._parse(resp);
  }

  async getPositions() { return this.get('/portfolio/positions'); }
  async getHoldings()  { return this.get('/portfolio/holdings'); }
  async getOrders()    { return this.get('/orders'); }
}
