// Model/state and host contracts. Real DOM, layout and input tests live in
// verify-capsule.mjs; source-string counts are not UI acceptance evidence.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { apply } from '../lib/index.js';
let checks = 0;
const test = (name, run) => { run(); checks++; console.log(`PASS: ${name}`); };
const provider = (extra = {}) => ({ id: 'x', label: 'Test', credential: 'TEST', endpoint: 'https://example.com/quota', ...extra });
function mount(config) {
  const routes = [], taps = [], disposers = [];
  apply({
    credentials: { resolve: async () => ({ value: 'synthetic-secret' }) },
    webServer: { register: route => { routes.push(route); return () => {}; }, tapIndex: fn => { taps.push(fn); return () => {}; } },
    effect: fn => { disposers.push(fn()); }
  }, config);
  return { routes, html: taps[0]('</body>'), disposers };
}
const rows = [provider(), provider({ id: 'u', format: 'opencode-usage' }), provider({ id: 'c', format: 'command-cost' })];
const mounted = mount({ providers: rows });
const script = mounted.html.slice('<script>'.length, mounted.html.lastIndexOf('</script>'));
test('complete emitted script compiles', () => new vm.Script(script));
test('three exact GET proxy routes', () => assert.deepEqual(mounted.routes.map(r => r.path), ['/api/quota/x', '/api/quota/u', '/api/quota/c']));
test('credential never embedded', () => assert.ok(!script.includes('synthetic-secret')));
test('closing script in label safely escaped', () => assert.ok(!mount({ providers: [provider({ label: '</script><script>alert(1)</script>' })] }).html.includes('</script><script>alert')));

for (const [name, config, pattern] of [
  ['infinite refresh', { refreshMs: Infinity }, /refreshMs/],
  ['NaN refresh', { refreshMs: NaN }, /refreshMs/],
  ['refresh too fast', { refreshMs: 1000 }, /refreshMs/],
  ['refresh too slow', { refreshMs: 90000000 }, /refreshMs/],
  ['bad thresholds', { providers: [provider({ warnPercent: 95, errorPercent: 80 })] }, /warnPercent/],
  ['threshold above 100', { providers: [provider({ errorPercent: 101 })] }, /warnPercent/],
  ['string threshold', { providers: [provider({ warnPercent: '70' })] }, /finite/],
  ['unordered balance tiers', { providers: [provider({ balanceTiers: { critical: 30, warn: 10 } })] }, /balanceTiers/],
  ['remote HTTP', { providers: [provider({ endpoint: 'http://example.com' })] }, /https/],
  ['unknown format', { providers: [provider({ format: 'unknown' })] }, /format/],
  ['invalid currency', { providers: [provider({ currency: 'DOLLARS' })] }, /currency/],
  ['duplicate id', { providers: [provider(), provider()] }, /duplicates/]
]) test(`reject ${name}`, () => assert.throws(() => mount({ providers: rows, ...config }), pattern));
test('loopback HTTP accepted', () => mount({ providers: [provider({ endpoint: 'http://127.0.0.1:8080/quota' })] }));
test('empty provider list accepted', () => mount({ providers: [] }));

// Expose private model functions only in the test's VM copy. Production has
// no test globals, no test endpoint and no credential access from the browser.
const marker = "  if (document.readyState === 'loading') {";
assert.ok(script.includes(marker));
const instrumented = script.replace(marker, `window.audit={numeric,clampPct,renderers:PROVIDER_RENDERERS,applyRender,state:STATE,last:LASTMODEL};renderCapsule=function(){};${marker}`);
const context = { window: {}, document: { readyState: 'loading', addEventListener() {} }, navigator: { language: 'zh-CN' }, localStorage: { getItem() { return null; } }, console };
vm.runInNewContext(instrumented, context);
const api = context.window.audit;
const spec = { id: 'x', label: 'Test', format: 'deepseek-balance', warnPercent: 70, errorPercent: 90 };
const balance = value => ({ ok: true, data: { balance_infos: [{ currency: 'CNY', total_balance: value }] } });
for (const value of [null, undefined, '', ' ', false, true, [], {}, NaN, Infinity, 'nope']) {
  test(`reject numeric ${String(value)}`, () => { assert.ok(Number.isNaN(api.numeric(value))); assert.equal(api.clampPct(value), undefined); });
}
test('numeric strings and zero preserved', () => { assert.equal(api.numeric('0'), 0); assert.equal(api.numeric(' 53.25 '), 53.25); assert.equal(api.clampPct(-1), undefined); });
test('fresh critical balance is valid', () => { api.applyRender(spec, balance('5')); assert.equal(api.state.x.summary, '¥5.00'); assert.equal(api.state.x.status, 'error'); });
test('healthy→critical uses newest balance', () => { api.applyRender(spec, balance('58')); api.applyRender(spec, balance('5')); assert.equal(api.state.x.summary, '¥5.00'); assert.equal(api.last.x.model.summary, '¥5.00'); });
test('critical→outage retains critical reading as stale', () => { api.applyRender(spec, { ok: false, error: { code: 'network' } }); assert.equal(api.state.x.summary, '¥5.00'); assert.equal(api.state.x.status, 'stale'); });
test('invalid balance never becomes zero', () => { api.applyRender(spec, balance(null)); assert.equal(api.state.x.summary, '¥5.00'); assert.equal(api.state.x.status, 'stale'); });
test('first-load invalid balance is unknown', () => { api.applyRender({ ...spec, id: 'new' }, balance(null)); assert.equal(api.state.new.summary, '—'); assert.equal(api.state.new.status, 'unknown'); });
test('recovery clears stale', () => { api.applyRender(spec, balance('80')); assert.equal(api.state.x.status, 'ok'); });
const usage = n => ({ ok: true, data: { usage: { rolling: { percent: n }, weekly: { percent: 20 }, monthly: { percent: 30 } } } });
const us = { ...spec, id: 'u', format: 'opencode-usage' };
test('critical usage is displayed, not rejected', () => { api.applyRender(us, usage(95)); assert.equal(api.state.u.summary, '95%'); assert.equal(api.state.u.status, 'error'); });
test('null usage does not become healthy zero', () => { api.applyRender(us, usage(null)); assert.equal(api.state.u.summary, '95%'); assert.equal(api.state.u.status, 'stale'); });
const cs = { ...spec, id: 'c', format: 'command-cost' };
test('monthly consumption is displayed as percentage and spend retained', () => { api.applyRender(cs, { ok: true, data: { usage: { totalCost: 95, totalMonthlyCredits: 95, periodBasis: 'billing-period' }, credits: { monthlyCredits: 5 } } }); assert.equal(api.state.c.summary, '95%'); assert.equal(api.last.c.model.value, '$95.00'); assert.equal(api.state.c.status, 'error'); });
test('purchased credit does not dilute monthly percentage', () => { api.applyRender(cs, { ok: true, data: { usage: { totalCost: 120, totalMonthlyCredits: 95, periodBasis: 'billing-period' }, credits: { monthlyCredits: 5, purchasedCredits: 500 } } }); assert.equal(api.state.c.summary, '95%'); });
test('missing monthly fields never infer percentage from total spend', () => { api.applyRender(cs, { ok: true, data: { usage: { totalCost: 95 }, credits: { monthlyCredits: 5 } } }); assert.equal(api.state.c.summary, '—'); });
test('null cost rejected', () => { api.applyRender(cs, { ok: true, data: { usage: { totalCost: null } } }); assert.equal(api.state.c.status, 'stale'); });

const oldFetch = globalThis.fetch;
try {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html>synthetic-secret</html>' });
  await mounted.routes[0].handler({ method: 'GET' }, res);
  test('upstream error body never echoed', () => { assert.ok(!res.body.includes('synthetic-secret')); assert.equal(JSON.parse(res.body).error.code, 'invalid-body'); });
  test('server marks quota response no-store', () => assert.equal(res.headers['cache-control'], 'no-store'));
  globalThis.fetch = async () => { throw new Error('synthetic-secret'); };
  await mounted.routes[0].handler({ method: 'GET' }, res);
  test('thrown error text not echoed', () => assert.ok(!res.body.includes('synthetic-secret')));
  await mounted.routes[0].handler({ method: 'POST' }, res);
  test('non-GET rejected', () => assert.equal(res.status, 405));
} finally { globalThis.fetch = oldFetch; }

// ── Carrier neutrality: the same plugin on the connection Fetch registry ──
// The Electron Desktop host has no `webServer`; the Web server mounts the very
// same registry under its `/api` prefix. Both must yield identical routes and
// the same structured index row.
function mountConnectionCarrier(config) {
  const routes = [], listeners = [];
  const ctx = {
    credentials: { resolve: async () => ({ value: 'synthetic-secret' }) },
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } },
    on: (event, fn) => { listeners.push([event, fn]); return () => {}; },
    effect: fn => { fn(); return () => {}; },
    inject: (_services, fn) => fn(ctx)
  };
  apply(ctx, config);
  const table = [];
  for (const [event, fn] of listeners) if (event === 'webserver/index-inject') fn(table);
  return { routes, table };
}
{
  const carrier = mountConnectionCarrier({ refreshMs: 60000, providers: [provider({ endpoint: 'http://127.0.0.1:1/quota' })] });
  test('connection carrier registers exact GET routes with a buffered body', () => assert.deepEqual(
    carrier.routes.map(r => [r.path, r.methods.join(','), r.requestBody]),
    [['/api/quota/x', 'GET', 'buffered']]));
  test('connection carrier contributes one structured index row', () => {
    assert.equal(carrier.table.length, 1);
    assert.equal(carrier.table[0].kind, 'script');
    assert.equal(carrier.table[0].placement, 'body');
    assert.ok(carrier.table[0].text.includes('DSH_PLUGIN_INTEGRATION_V1'));
    // A row carries text, never markup: no literal tag may close the host's.
    assert.ok(!carrier.table[0].text.includes('</script'));
    assert.ok(!carrier.table[0].text.includes('synthetic-secret'));
  });
  test('connection carrier ships a compilable widget script', () => {
    // The row text is the whole injected body (runtime + widget): compiling it
    // as one script proves the row form needs no markup wrapper.
    new vm.Script(carrier.table[0].text);
    assert.ok(carrier.table[0].text.includes('/*QUOTA_PAGE_SCRIPT_START*/'));
  });
  const url = 'http://dsh.internal/api/quota/x';
  const post = await carrier.routes[0].fetch(new Request(url, { method: 'POST' }));
  const res = await carrier.routes[0].fetch(new Request(url));
  const body = await res.json();
  test('connection carrier rejects non-GET', () => assert.equal(post.status, 405));
  test('connection carrier answers the shared envelope on a dead endpoint', () => {
    assert.equal(res.status, 502);
    assert.equal(body.ok, false);
    assert.ok(['network', 'timeout'].includes(body.error.code));
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
}

console.log(`${checks} model, configuration and security checks passed`);
