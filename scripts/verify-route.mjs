// Host-route verification for dsh-quota-panel — no browser involved.
//
// Part 1 (offline, always runs): registers the plugin against a local HTTP
//   stub and asserts the normalized envelope contract — success, missing
//   credential, upstream failure, and a non-JSON body. Also proves the
//   loopback-http exception is real (the stub is http://127.0.0.1).
//
// Part 2 (live, opt-in): when a Command Code key is available, calls the real
//   /api/quota/<id> handler and asserts the merged credits + usage/summary
//   body carries a finite period spend. Skipped with a notice otherwise.
//
// Usage: node scripts/verify-route.mjs
// Key lookup: $DSH_QUOTA_COMMAND_KEY, else COMMAND_API_KEY in
//             $DSH_HOME/.credentials.yaml (default ~/.dsh).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const plugin = await import(new URL('../lib/index.js', import.meta.url));

let failures = 0;
const check = (name, pass, detail = '') => {
	console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
	if (!pass) failures += 1;
};

/** Apply the plugin against a stub context and return its registered routes. */
function mountProviders(providers, resolveCredential) {
	const routes = new Map();
	plugin.apply({
		credentials: { resolve: resolveCredential },
		webServer: {
			register: (route) => { routes.set(route.path, route.handler); return () => {}; },
			tapIndex: () => () => {}
		},
		effect: (fn) => { fn(); return () => {}; }
	}, { refreshMs: 60000, providers });
	return routes;
}

const callRoute = async (handler, method = 'GET') => {
	const res = {
		status: 0,
		headers: null,
		body: '',
		writeHead(status, headers) { this.status = status; this.headers = headers; },
		end(chunk) { this.body = chunk ?? ''; }
	};
	await handler({ method }, res);
	let parsed = null;
	try { parsed = JSON.parse(res.body); } catch { /* left null */ }
	return { status: res.status, headers: res.headers, parsed, raw: res.body };
};

// ── Part 1: envelope contract against a local stub ──────────────────────
const stub = createServer((req, res) => {
	if (req.url.startsWith('/good')) {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '58.36' }] }));
		return;
	}
	if (req.url.startsWith('/html')) {
		// A proxy's HTML error page with a 200: the classic "response.json()
		// would have thrown" case.
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html><body>gateway</body></html>');
		return;
	}
	res.writeHead(500, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ message: 'boom' }));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

const provider = (over) => ({ id: 'x', label: 'X', credential: 'K', endpoint: `${stubBase}/good`, format: 'deepseek-balance', ...over });
const always = async () => ({ value: 'secret-key' });
const missing = async () => undefined;

{
	const routes = mountProviders([provider()], always);
	const ok = await callRoute(routes.get('/api/quota/x'));
	check('route: success is wrapped as ok+data', ok.status === 200 && ok.parsed?.ok === true && ok.parsed?.data?.balance_infos?.[0]?.total_balance === '58.36', JSON.stringify(ok.parsed)?.slice(0, 90));
	check('route: answers JSON content-type', /application\/json/.test(ok.headers?.['content-type'] ?? ''));

	const post = await callRoute(routes.get('/api/quota/x'), 'POST');
	check('route: non-GET is rejected', post.status === 405 && post.parsed?.ok === false, `${post.status} ${post.parsed?.error?.code}`);
}
{
	const routes = mountProviders([provider()], missing);
	const out = await callRoute(routes.get('/api/quota/x'));
	check('route: missing credential is an explicit code, not a red error page',
		out.status === 200 && out.parsed?.ok === false && out.parsed?.error?.code === 'credentials', JSON.stringify(out.parsed?.error));
}
{
	const routes = mountProviders([provider({ endpoint: `${stubBase}/boom` })], always);
	const out = await callRoute(routes.get('/api/quota/x'));
	check('route: upstream 500 becomes code upstream',
		out.status === 502 && out.parsed?.ok === false && out.parsed?.error?.code === 'upstream', JSON.stringify(out.parsed?.error));
}
{
	const routes = mountProviders([provider({ endpoint: `${stubBase}/html` })], always);
	const out = await callRoute(routes.get('/api/quota/x'));
	check('route: a 200 HTML body never reaches the browser as data',
		out.parsed?.ok === false && out.parsed?.error?.code === 'invalid-body', JSON.stringify(out.parsed?.error)?.slice(0, 100));
}
{
	const routes = mountProviders([provider({ endpoint: 'https://127.0.0.1:1/nothing' })], always);
	const out = await callRoute(routes.get('/api/quota/x'));
	check('route: an unreachable host becomes a transport code',
		out.status === 502 && out.parsed?.ok === false && ['network', 'timeout'].includes(out.parsed?.error?.code), JSON.stringify(out.parsed?.error));
}
stub.close();

// ── Part 2: live Command Code round trip ────────────────────────────────
function readCommandKey() {
	if (process.env.DSH_QUOTA_COMMAND_KEY) return process.env.DSH_QUOTA_COMMAND_KEY.trim();
	const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
	try {
		const yaml = readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
		const match = yaml.match(/COMMAND_API_KEY\s*[:=]\s*["']?([^"'\s]+)/);
		return match ? match[1].trim() : null;
	} catch {
		return null;
	}
}

// Live credentials are never read as a side effect of an offline test.
const key = process.argv.includes('--live') ? readCommandKey() : null;
if (!key) {
	console.log('SKIP: live route check (requires explicit --live and credentials)');
} else {
	const routes = mountProviders(
		[{ id: 'command', label: 'Command Code', credential: 'COMMAND_API_KEY', endpoint: 'https://api.commandcode.ai', format: 'command-cost' }],
		async (name) => (name === 'COMMAND_API_KEY' ? { value: key } : undefined)
	);
	const out = await callRoute(routes.get('/api/quota/command'));
	const data = out.parsed?.data;
	check('live: command route answers ok', out.parsed?.ok === true, JSON.stringify(out.parsed?.error));
	check('live: period spend is a finite number', Number.isFinite(data?.usage?.totalCost), `totalCost=${data?.usage?.totalCost}`);
	check('live: credits + windowLimits came through',
		Number.isFinite(Number(data?.credits?.monthlyCredits)) && data?.windowLimits?.fiveHour !== undefined,
		`monthlyCredits=${data?.credits?.monthlyCredits} cap=${data?.windowLimits?.fiveHour?.cap}`);
	check('live: token + request counts present',
		Number.isFinite(Number(data?.usage?.totalTokens)) && Number.isFinite(Number(data?.usage?.totalCount)),
		`${data?.usage?.totalCount} requests · ${data?.usage?.totalTokens} tokens`);
	check('live: the API key never appears in the response body', !out.raw.includes(key));
	console.log(`     spend=$${data?.usage?.totalCost} · remaining=$${data?.credits?.monthlyCredits}`);
}

console.log(`\n${failures === 0 ? 'all route checks passed' : `${failures} CHECK(S) FAILED`}`);
if (failures) process.exit(1);
