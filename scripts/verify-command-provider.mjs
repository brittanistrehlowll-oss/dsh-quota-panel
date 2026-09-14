// 端到端校验：用真实 cordis.patch.yml + 真实凭据存储，在进程内挂载 quota-panel，
// 捕获它注册的 /api/quota/<id> 路由并逐个调用（不经 HTTP、不碰线上宿主）。
// 用途：改配置后、重启前先证明三行 provider 都能取到数据。
// 只打印额度数值与结构，不回显密钥。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

// The plugin itself is zero-dependency, so this harness borrows a YAML parser
// from a DSH install instead of adding one to package.json. Point DSH_YAML (or
// DSH_ROOT) at it when the install lives somewhere unusual.
function loadYaml() {
	const candidates = [
		process.env.DSH_YAML,
		process.env.DSH_ROOT && path.join(process.env.DSH_ROOT, 'node_modules', 'yaml'),
		path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'profiles', 'node_modules', 'yaml')
	].filter(Boolean);
	for (const candidate of candidates) {
		try { return require(candidate); } catch { /* try the next candidate */ }
	}
	console.error('SKIP: no `yaml` module found — set DSH_YAML to a yaml package directory');
	process.exit(0);
}

const YAML = loadYaml();
const doc = YAML.parse(readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8'));
const row = doc.flatMap((e) => e.insert ?? []).find((i) => i.id === 'quota-panel');

const credentialsRaw = readFileSync(path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8');
const resolveCredential = (name) => {
  const m = credentialsRaw.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'));
  return m ? { value: m[1] } : undefined;
};

const { apply } = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href);

const routes = new Map();
const ctx = {
  effect: (fn) => fn(),
  credentials: { resolve: async (name) => resolveCredential(name) },
  webServer: {
    register: ({ path, handler }) => { routes.set(path, handler); return () => {}; },
    tapIndex: () => () => {}
  }
};

apply(ctx, row.config);
console.log(`routes registered: ${[...routes.keys()].join(', ')}\n`);

const callRoute = (path) => new Promise((resolve) => {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this; },
    end(body) { if (body !== undefined) chunks.push(body); resolve({ status: this.statusCode, body: chunks.join('') }); },
    write(body) { chunks.push(body); }
  };
  Promise.resolve(routes.get(path)({ method: 'GET' }, res)).catch((e) => resolve({ status: 0, body: `THREW: ${e && e.stack ? e.stack : e}` }));
});

let pass = 0, fail = 0;
for (const p of row.config.providers) {
  const path = `/api/quota/${p.id}`;
  if (!routes.has(path)) { console.log(`✗ ${p.id}: route missing`); fail++; continue; }
  const t0 = Date.now();
  const r = await callRoute(path);
  const ms = Date.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch { /* leave null */ }
  const ok = r.status === 200 && parsed && parsed.ok !== false;
  console.log(`${ok ? '✓' : '✗'} ${p.id.padEnd(12)} HTTP ${r.status} ${ms}ms  format=${p.format}`);
  // The route answers the normalized envelope: failures carry error.{code,message}.
  if (parsed && parsed.ok === false) console.log(`    error: code=${parsed.error?.code} status=${parsed.error?.status} message=${parsed.error?.message}`);
  if (!ok && !parsed) console.log(`    raw: ${String(r.body).slice(0, 300)}`);
  if (p.format === 'command-cost' && parsed?.ok) {
    const d = parsed.data ?? parsed;
    console.log(`    credits: monthly=${d.credits?.monthlyCredits} purchased=${d.credits?.purchasedCredits} free=${d.credits?.freeCredits}`);
    console.log(`    windows: fiveHour=${JSON.stringify(d.windowLimits?.fiveHour)} weekly=${JSON.stringify(d.windowLimits?.weekly)}`);
    console.log(`    usage:   totalCost=${d.usage?.totalCost} totalCount=${d.usage?.totalCount} totalTokens=${d.usage?.totalTokens}`);
    const remaining = ['monthlyCredits', 'purchasedCredits', 'freeCredits']
      .reduce((s, k) => s + (Number(d.credits?.[k]) || 0), 0);
    const cost = Number(d.usage?.totalCost);
    if (Number.isFinite(cost) && remaining > 0) {
      console.log(`    derived: spend $${cost.toFixed(2)} + remaining $${remaining.toFixed(2)} = allowance $${(cost + remaining).toFixed(2)} → ${((cost / (cost + remaining)) * 100).toFixed(1)}%`);
    }
  }
  ok ? pass++ : fail++;
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
