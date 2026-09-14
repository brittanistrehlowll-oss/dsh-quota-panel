// 一次性探针：验证 commandcode alpha 计费三端点与 dsh-quota-panel 的 command-cost 契约是否吻合。
// 只输出结构与数值，不回显密钥或账户标识。
// 凭据来源：$DSH_QUOTA_COMMAND_KEY，否则 $DSH_HOME/.credentials.yaml（默认 ~/.dsh）。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function readKey() {
	if (process.env.DSH_QUOTA_COMMAND_KEY) return process.env.DSH_QUOTA_COMMAND_KEY.trim();
	const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
	const raw = readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
	const match = raw.match(/COMMAND_API_KEY\s*[:=]\s*["']?([^"'\s]+)/);
	if (!match) throw new Error(`COMMAND_API_KEY not found in ${path.join(home, '.credentials.yaml')}`);
	return match[1].trim();
}

const key = readKey();

const base = 'https://api.commandcode.ai';
const headers = { accept: 'application/json', authorization: `Bearer ${key}` };

const shape = (v, depth = 0) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(len=${v.length})${v.length && depth < 2 ? ' of ' + shape(v[0], depth + 1) : ''}`;
  if (typeof v === 'object') {
    if (depth >= 2) return 'object';
    return '{' + Object.entries(v).map(([k, x]) => `${k}: ${shape(x, depth + 1)}`).join(', ') + '}';
  }
  return typeof v;
};

const get = async (url) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

console.log('Read-only quota probe; credentials and account identifiers omitted.');

const who = await get(`${base}/alpha/whoami`);
console.log(`\n[1] GET /alpha/whoami -> ${who.status}`);
console.log('    shape:', shape(who.body));
const orgId = who.body?.org?.id;
console.log('    org.id present:', Boolean(orgId));

const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
const [credits, usage] = await Promise.all([
  get(`${base}/alpha/billing/credits${q}`),
  get(`${base}/alpha/usage/summary${q}`)
]);

console.log(`\n[2] GET /alpha/billing/credits -> ${credits.status}`);
console.log('    shape:', shape(credits.body));
if (credits.body) {
  const c = credits.body.credits ?? {};
  console.log('    credits numbers:', {
    monthlyCredits: c.monthlyCredits, purchasedCredits: c.purchasedCredits, freeCredits: c.freeCredits
  });
  const wl = credits.body.windowLimits ?? {};
  console.log('    windowLimits:', Object.fromEntries(Object.entries(wl).map(([k, v]) => [k, { used: v?.used, cap: v?.cap, resetAt: v?.resetAt ?? null }])));
}

console.log(`\n[3] GET /alpha/usage/summary -> ${usage.status}`);
console.log('    shape:', shape(usage.body));
if (usage.body) {
  console.log('    usage numbers:', {
    totalCost: usage.body.totalCost, totalCount: usage.body.totalCount,
    totalTokens: usage.body.totalTokens, averageCost: usage.body.averageCost,
    totalMonthlyCredits: usage.body.totalMonthlyCredits,
    totalPurchasedCredits: usage.body.totalPurchasedCredits,
    totalFreeCredits: usage.body.totalFreeCredits,
    periodBasis: usage.body.periodBasis,
    successRate: usage.body.successRate
  });
}
