/**
 * dsh-quota-panel — one-line/two-line quota capsule for the dsh browser surface
 * (the Web server and the Electron Desktop host share it).
 *
 * Host plugin (zero runtime dependencies):
 *  - registers one carrier-neutral proxy route per provider
 *    (`/api/quota/<id>`); API keys stay server-side (resolved via
 *    `ctx.credentials`), never in the browser. The route lives on the
 *    `connection` Fetch registry, which the Web server mounts on its HTTP
 *    `/api` prefix and the Desktop host dispatches its piped `/api` requests
 *    into — one registration serves both carriers. Hosts without that registry
 *    fall back to `webServer.register` + `tapIndex`.
 *  - injects a self-contained page script that renders a Harness-native
 *    status widget: one-line capsule ⇄ two-line capsule with position lock,
 *    auto-refresh, bilingual (中文/English).
 *  - OPTIONAL host-page integration: when the neutral runtime
 *    `window.DSH_PLUGIN_INTEGRATION_V1` is present, a `quota` module registers
 *    with `getSnapshot()`, `actions.refresh`, `mountCompact(container)`,
 *    `unmountCompact()` and `openDetail()`. This is the supported way for a
 *    host page to embed the compact capsule without touching its DOM classes;
 *    the plugin never creates UI itself, and standalone behaviour is unchanged
 *    when the runtime is absent.
 *
 * Provider renderers live in PROVIDER_RENDERERS below so a new provider only
 * needs a new adapter (validate/normalize/deriveState/compactValue/detailModel)
 * — no if/else sprawl in the render path. Config format stays compatible.
 *
 * Host plugin (zero runtime dependencies):
 *  1. For every configured provider it registers one server-side proxy route
 *     `/api/quota/<id>`. The API key is resolved through `ctx.credentials` and
 *     never reaches the browser; the endpoint is called host-side with
 *     `Authorization: Bearer <key>` and the JSON body is passed through.
 *  2. It injects a self-contained page script through the host's structured
 *     index-injection table (`webserver/index-inject`) — the same row table the
 *     Web server renders into index.html and the Desktop host publishes for its
 *     asset handler. Default placement is bottom-left, independently of other
 *     plugins. Clicking the same control toggles 28/56px heights; a sibling
 *     lock button prevents dragging.
 *
 * The widget is styled with the Harness design tokens (`--dsw-alias-*`,
 * `--dsw-static-*`, `--dsw-font-*`) and falls back to
 * sensible values when tokens are absent, so it follows the product theme
 * (light/dark) instead of carrying its own palette.
 *
 * Providers are config-driven. Each entry:
 *
 *   id:          route id, also the row key (`/api/quota/<id>`); ^[a-z0-9-]+$
 *   label:       provider name, e.g. "DeepSeek"
 *   credential:  credential reference, e.g. "DEEPSEEK_API_KEY"
 *   endpoint:    quota/balance JSON endpoint to proxy (GET, Bearer auth)
 *   format:      row renderer: "deepseek-balance" | "opencode-usage"
 *                | "command-cost"
 *   balanceTiers: (deepseek-balance) balance levels { critical, warn, healthy },
 *                defaults { 10, 20, 50 }: <=critical "建议充值" (red),
 *                <=warn "余额紧张" (amber), <=healthy "余额正常", else "余额充足"
 *   lowBalance:  legacy alias for balanceTiers.warn
 *   windowLabels: (opencode-usage) labels for the three windows, defaults
 *                { rolling: "滚", weekly: "周", monthly: "月" };
 *                (command-cost) labels for { fiveHour, weekly }
 *   warnPercent / errorPercent: (opencode-usage, command-cost) thresholds,
 *                defaults 70 / 90
 *
 * command-cost (Command Code): `endpoint` is the API *base*
 * (https://api.commandcode.ai), not a single JSON route — the alpha API needs a
 * whoami lookup for the optional orgId before the two reads. The host does all
 * three calls and hands the browser one merged body:
 *
 *   { credits: { monthlyCredits, purchasedCredits, freeCredits },
 *     windowLimits: { fiveHour: { used, cap, resetAt }, weekly: { … } },
 *     usage: { totalCost, totalCount, totalTokens, averageCost, successRate } }
 *
 * The row headlines the billing-period spend (usage.totalCost, in USD — the
 * same unit as the credits) and meters it against the period allowance
 * (spend + remaining credits).
 *
 * Example mount (profile patch):
 *
 *   - insert:
 *       - id: quota-panel
 *         name: 'dsh-quota-panel'
 *         inject: [credentials]
 *         config:
 *           refreshMs: 60000
 *           providers:
 *             - id: deepseek
 *               label: DeepSeek
 *               credential: DEEPSEEK_API_KEY
 *               endpoint: https://api.deepseek.com/user/balance
 *               format: deepseek-balance
 *             - id: opencode-go
 *               label: OpenCode Go
 *               credential: OPENCODE_GO_API_KEY
 *               endpoint: https://opencode.ai/zen/go/v1/usage
 *               format: opencode-usage
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'quota-panel';

// Only `credentials` is mandatory: the data carrier is discovered at apply time
// (`connection`'s exact Fetch registry first, the Web server route table next),
// so the same plugin activates on the Web server and on the Desktop host.
export const inject = ['credentials'];

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

// Auto-refresh bounds: below 5s the panel would poll provider billing APIs
// harder than a dashboard should; above a day it stops being "auto" refresh.
const MIN_REFRESH_MS = 5000;
const MAX_REFRESH_MS = 24 * 60 * 60 * 1000;

// The neutral internal integration runtime (see lib/plugin-integration-v1.js).
// Inlined at the top of the injected page script so independent plugins share
// one idempotent singleton on window.DSH_PLUGIN_INTEGRATION_V1.
const INTEGRATION_RUNTIME = readFileSync(fileURLToPath(new URL('./plugin-integration-v1.js', import.meta.url)), 'utf8');
const CAPSULE_CSS = readFileSync(fileURLToPath(new URL('./capsule.css', import.meta.url)), 'utf8');
// The panel's own version, reported to the page as `data-version`. Read from the
// package manifest so the marker can never drift from the published version.
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

function sendJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

/**
 * Every route answers with the same envelope, so the page script never has to
 * guess whether a body is data or an error, and never JSON-parses an upstream
 * HTML error page:
 *
 *   { ok: true,  data: <object> }
 *   { ok: false, error: { code, status?, message } }
 *
 * `code` is one of: credentials | upstream | timeout | network | invalid-body.
 * Both carriers build these bodies here, so a Web answer and a Desktop answer
 * are byte-identical.
 */
function okEnvelope(data) {
	return { ok: true, data };
}

function errorEnvelope(status, code, message) {
	return { ok: false, error: { code, status, message } };
}

/** Map a thrown fetch/AbortSignal failure onto an envelope error code. */
function errorCodeOf(error) {
	const name = error && error.name;
	if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
	return 'network';
}

/**
 * Resolve one provider host-side and normalize the outcome into
 * `{ status, body }`. Shared by both carriers, so the Web server and the
 * Desktop host answer from exactly one code path.
 * @param ctx - context owning the `credentials` service.
 * @param provider - normalized provider spec.
 */
async function readProvider(ctx, provider) {
	try {
		const hit = await ctx.credentials.resolve(provider.credential);
		if (!hit) {
			// A missing credential is a configuration state, not a transport
			// failure: 200 + a code the UI can explain.
			return { status: 200, body: errorEnvelope(200, 'credentials', `${provider.credential} is not configured`) };
		}
		// command-cost fans out to three routes (whoami → credits +
		// usage/summary), so it does not share the one-fetch path.
		if (provider.format === 'command-cost') {
			const result = await fetchCommandCost(provider.endpoint, hit.value);
			return result.ok
				? { status: 200, body: okEnvelope(result.data) }
				: { status: 502, body: errorEnvelope(502, result.code, result.message) };
		}
		const upstream = await fetch(provider.endpoint, {
			headers: { authorization: `Bearer ${hit.value}` },
			signal: AbortSignal.timeout(15000)
		});
		if (!upstream.ok) {
			return { status: 502, body: errorEnvelope(502, 'upstream', `upstream responded ${upstream.status}`) };
		}
		const body = await readJson(upstream);
		return body.ok
			? { status: 200, body: okEnvelope(body.data) }
			: { status: 502, body: errorEnvelope(502, body.code, body.message) };
	} catch (error) {
		return { status: 502, body: errorEnvelope(502, errorCodeOf(error), 'provider request failed') };
	}
}

/**
 * Read an upstream response as JSON, tolerating a non-JSON body (a proxy's
 * HTML error page, an empty 200, …).
 * @returns {Promise<{ok: true, data: object} | {ok: false, code: string, message: string}>}
 */
async function readJson(response) {
	let text;
	try {
		text = await response.text();
	} catch (error) {
		return { ok: false, code: 'invalid-body', message: 'upstream body could not be read' };
	}
	try {
		const data = JSON.parse(text);
		if (!data || typeof data !== 'object') return { ok: false, code: 'invalid-body', message: 'body is not a JSON object' };
		return { ok: true, data };
	} catch {
		return { ok: false, code: 'invalid-body', message: 'upstream returned a non-JSON response' };
	}
}

/** Numeric config field with a default; a non-finite value falls back. */
function numOf(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate and normalize an endpoint URL. The proxy attaches
 * `Authorization: Bearer <credential>`, so plain http is refused unless the
 * host is loopback — sending a live API key over cleartext to a remote host is
 * never a configuration we want to accept silently.
 */
function endpointUrl(value, at) {
	let url;
	try {
		url = new URL(String(value));
	} catch {
		throw new Error(`${at}.endpoint must be an absolute http(s) URL`);
	}
	if (url.protocol === 'https:') return url.toString().replace(/\/$/, '');
	if (url.protocol !== 'http:') throw new Error(`${at}.endpoint must use https`);
	const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
	if (!loopback) throw new Error(`${at}.endpoint must use https (http is allowed for localhost only)`);
	return url.toString().replace(/\/$/, '');
}

/**
 * Strict numeric config field: absent → default, present but not a finite
 * number → throw. Silently substituting the default for a typo'd threshold
 * would hide the mistake behind plausible-looking colours.
 */
function numField(value, fallback, at, field) {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at}.${field} must be a finite number`);
	return value;
}

/** Normalize and validate the plugin config; throws with a readable message. */
function normalizeConfig(raw) {
	const config = { refreshMs: 5000, providers: [], ...(raw && typeof raw === 'object' ? raw : {}) };
	if (typeof config.refreshMs !== 'number' || !Number.isFinite(config.refreshMs)
		|| config.refreshMs < MIN_REFRESH_MS || config.refreshMs > MAX_REFRESH_MS) {
		throw new Error(`quota-panel: config.refreshMs must be a finite number between ${MIN_REFRESH_MS} and ${MAX_REFRESH_MS}`);
	}
	if (!Array.isArray(config.providers)) throw new Error('quota-panel: config.providers must be an array');
	const seen = new Set();
	const providers = config.providers.map((entry, index) => {
		const at = `quota-panel: config.providers[${index}]`;
		if (!entry || typeof entry !== 'object') throw new Error(`${at} must be an object`);
		const { id, label, credential, format = 'deepseek-balance' } = entry;
		if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) throw new Error(`${at}.id must match /^[a-z0-9-]+$/`);
		if (seen.has(id)) throw new Error(`${at}.id duplicates "${id}"`);
		seen.add(id);
		if (typeof label !== 'string' || !label) throw new Error(`${at}.label must be a non-empty string`);
		if (typeof credential !== 'string' || !credential) throw new Error(`${at}.credential must be a non-empty string`);
		const endpoint = endpointUrl(entry.endpoint, at);
		if (format !== 'deepseek-balance' && format !== 'opencode-usage' && format !== 'command-cost') {
			throw new Error(`${at}.format must be "deepseek-balance", "opencode-usage" or "command-cost"`);
		}
		// Window labels: explicit user labels win; null means "use the UI
		// language's default labels" (billed in the injected script). `fiveHour`
		// is only read by command-cost, the other three only by opencode-usage.
		const windowLabels = entry.windowLabels && typeof entry.windowLabels === 'object'
			? {
				rolling: String(entry.windowLabels.rolling ?? ''),
				weekly: String(entry.windowLabels.weekly ?? ''),
				monthly: String(entry.windowLabels.monthly ?? ''),
				fiveHour: String(entry.windowLabels.fiveHour ?? '')
			}
			: null;
		// Thresholds are the "used" percentage at which a row turns amber/red.
		const warnPercent = numField(entry.warnPercent, 70, at, 'warnPercent');
		const errorPercent = numField(entry.errorPercent, 90, at, 'errorPercent');
		if (!(warnPercent >= 0 && warnPercent < errorPercent && errorPercent <= 100)) {
			throw new Error(`${at} must satisfy 0 <= warnPercent < errorPercent <= 100`);
		}
		// Balance tiers: explicit object wins, legacy lowBalance maps to warn.
		const tiers = entry.balanceTiers && typeof entry.balanceTiers === 'object'
			? {
				critical: numField(entry.balanceTiers.critical, 10, at, 'balanceTiers.critical'),
				warn: numField(entry.balanceTiers.warn, 20, at, 'balanceTiers.warn'),
				healthy: numField(entry.balanceTiers.healthy, 50, at, 'balanceTiers.healthy')
			}
			: entry.lowBalance !== undefined
				? { critical: numField(entry.lowBalance, 20, at, 'lowBalance') / 2, warn: numField(entry.lowBalance, 20, at, 'lowBalance'), healthy: 50 }
				: { critical: 10, warn: 20, healthy: 50 };
		if (!(tiers.critical >= 0 && tiers.critical <= tiers.warn && tiers.warn <= tiers.healthy)) {
			throw new Error(`${at}.balanceTiers must satisfy 0 <= critical <= warn <= healthy`);
		}
		// Currency is only meaningful for the cost renderer (Command Code quotes
		// USD credits); deepseek-balance takes its currency from the payload.
		const currency = entry.currency === undefined ? null : String(entry.currency).toUpperCase();
		if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error(`${at}.currency must be a 3-letter ISO code`);
		return { id, label, credential, endpoint, format, windowLabels, warnPercent, errorPercent, balanceTiers: tiers, currency };
	});
	return { refreshMs: config.refreshMs, providers };
}

/** JSON-safe row spec embedded into the injected page script. */
function rowSpec(provider) {
	return {
		id: provider.id,
		label: provider.label,
		format: provider.format,
		windowLabels: provider.windowLabels,
		warnPercent: provider.warnPercent,
		errorPercent: provider.errorPercent,
		balanceTiers: provider.balanceTiers,
		currency: provider.currency
	};
}

/**
 * Command Code (`command-cost`) is not a single route: the alpha API needs a
 * whoami lookup for the (optional) orgId before the two billing reads. All
 * three calls happen host-side so the API key never reaches the browser; the
 * browser gets one merged JSON body.
 * @param base - API base URL, e.g. https://api.commandcode.ai
 * @param key - resolved credential value (Bearer).
 * @returns {Promise<{ok: true, data: object} | {ok: false, code: string, status?: number, message: string}>}
 */
async function fetchCommandCost(base, key) {
	const headers = { accept: 'application/json', authorization: `Bearer ${key}` };
	const root = String(base).replace(/\/+$/, '');
	const whoami = await fetch(`${root}/alpha/whoami`, { headers, signal: AbortSignal.timeout(15000) });
	if (!whoami.ok) return { ok: false, code: 'upstream', status: whoami.status, message: `whoami ${whoami.status}` };
	const whoamiBody = await readJson(whoami);
	if (!whoamiBody.ok) return { ok: false, code: whoamiBody.code, message: `whoami ${whoamiBody.message}` };
	const orgId = whoamiBody.data?.org?.id;
	const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
	const [creditsRes, usageRes] = await Promise.all([
		fetch(`${root}/alpha/billing/credits${query}`, { headers, signal: AbortSignal.timeout(15000) }),
		fetch(`${root}/alpha/usage/summary${query}`, { headers, signal: AbortSignal.timeout(15000) })
	]);
	if (!creditsRes.ok || !usageRes.ok) {
		return { ok: false, code: 'upstream', status: Math.max(creditsRes.status, usageRes.status), message: `credits ${creditsRes.status} / usage ${usageRes.status}` };
	}
	const [billing, usage] = await Promise.all([readJson(creditsRes), readJson(usageRes)]);
	if (!billing.ok) return { ok: false, code: billing.code, message: `credits ${billing.message}` };
	if (!usage.ok) return { ok: false, code: usage.code, message: `usage ${usage.message}` };
	return {
		ok: true,
		data: {
			credits: billing.data.credits ?? {},
			windowLimits: billing.data.windowLimits ?? {},
			usage: usage.data
		}
	};
}

/**
 * Build the injected page-script body (no surrounding `<script>` tags — an
 * index-injection row carries text, not markup). ROWS is a JSON literal, so
 * every value is JSON-escaped; the body contains no literal `</script>`.
 * @param rows - the provider row specs.
 * @param refreshMs - auto-refresh interval.
 */
function buildPageScript(rows, refreshMs) {
	const rowsJson = JSON.stringify(rows).replace(/</g, '\\u003C');
	const script = `(function () {
  var AUTO_MS = ${refreshMs};
  var ROWS = ${rowsJson};
  var VERSION = ${JSON.stringify(VERSION)};
  var panelId = 'dsh-quota-panel';
  var capsuleId = 'dsh-quota-capsule';
  var cardId = 'dsh-quota-detail';
  var STATE = {};      // spec.id -> { status, summary, hint }
  var LASTMODEL = {};  // spec.id -> { model, at } last successful reading
  var CAPSULE_DOTS = {};   // spec.id -> capsule dot element
  var CAPSULE_VALUES = {}; // spec.id -> capsule value element
  var DETAIL_VALUES = {}; // spec.id -> expanded value element
  var capsuleEl = null;
  var compactEl = null;
  var detailEl = null;
  var panelEl = null;
  var lockEl = null;
  var refreshEl = null;
  var locked = false;
  var expanded = false;
  var mountSlot = null;
  var refreshing = false;

  // ── Bilingual UI (中文 / English) ──────────────────────────
  // Default follows navigator.language; a manual choice (zh/en) is
  // persisted in localStorage and wins over the browser default.
  var LANG_KEY = 'dsh.quota.lang';
  var LANG = (function () {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch (e) { /* ignore */ }
    return /^zh/i.test((navigator.language || 'en')) ? 'zh' : 'en';
  })();
  var I18N = {
    zh: {
      title: '计费面板',
      ariaExpand: '展开计费面板',
      capsuleHint: '拖动可移动',
      ariaRefresh: '刷新计费面板',
      ariaCollapse: '收起计费面板',
      ariaLang: '切换语言',
      updating: '正在更新…',
      balanceUnavailable: '暂时无法获取余额',
      balanceInvalid: '余额数据异常',
      tierRecharge: '建议充值',
      tierTight: '余额紧张',
      tierOk: '余额正常',
      tierSurplus: '余额充足',
      usageUnavailable: '暂时无法获取用量',
      usageCaption: '当前最高占用 {h}%',
      costUnavailable: '暂时无法获取费用',
      costRequests: '{n} 次',
      costRemaining: '剩余 {v}',
      costSpend: '本周期费用',
      costPool: '周期额度',
      staleUpdated: '数据更新于 {time}',
      staleUnavailable: '{label} 暂时无法刷新',
      staleHint: '{label} · {time} 的数据',
      resetsSoon: '即将重置',
      days: '{n}天',
      hours: '{n}小时',
      minutes: '{n}分',
      resetsAt: '重置于',
      winRolling: '滚',
      winWeekly: '周',
      winMonthly: '月',
      winFiveHour: '五',
      winPeriod: '本周期'
    },
    en: {
      title: 'Billing',
      ariaExpand: 'Expand billing',
      capsuleHint: 'Drag to move',
      ariaRefresh: 'Refresh billing',
      ariaCollapse: 'Collapse billing',
      ariaLang: 'Switch language',
      updating: 'Updating…',
      balanceUnavailable: 'Balance unavailable',
      balanceInvalid: 'Invalid balance data',
      tierRecharge: 'Top up recommended',
      tierTight: 'Balance low',
      tierOk: 'Balance OK',
      tierSurplus: 'Balance sufficient',
      usageUnavailable: 'Usage unavailable',
      usageCaption: 'Highest usage {h}%',
      costUnavailable: 'Cost unavailable',
      costRequests: '{n} requests',
      costRemaining: '{v} left',
      costSpend: 'Period spend',
      costPool: 'Period allowance',
      staleUpdated: 'Updated {time}',
      staleUnavailable: '{label} refresh failed',
      staleHint: '{label} · data from {time}',
      resetsSoon: 'resets soon',
      days: '{n}d',
      hours: '{n}h',
      minutes: '{n}m',
      resetsAt: 'resets at',
      winRolling: 'Rolling',
      winWeekly: 'Weekly',
      winMonthly: 'Monthly',
      winFiveHour: '5h',
      winPeriod: 'Period'
    }
  };
  function t(key) { return (I18N[LANG] && I18N[LANG][key]) || I18N.zh[key] || key; }
  // NOTE: this lives inside a template literal upstream, so every backslash is
  // doubled — including the one in \\w. Without that the emitted regex is
  // /\\{(w+)\\}/ and placeholders silently survive into the UI.
  function fill(template, vars) {
    return template.replace(/\\{(\\w+)\\}/g, function (_, k) { return vars[k] !== undefined ? vars[k] : '{' + k + '}'; });
  }
  // Window labels: explicit user labels win (even when null-valued the
  // shipped defaults are replaced per-language); null specs follow the
  // UI language's default labels.
  function windowLabels(spec) {
    var w = spec.windowLabels;
    return {
      rolling: (w && w.rolling) || t('winRolling'),
      weekly: (w && w.weekly) || t('winWeekly'),
      monthly: (w && w.monthly) || t('winMonthly'),
      fiveHour: (w && w.fiveHour) || t('winFiveHour')
    };
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtReset(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return t('resetsSoon');
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.round(s / 60);
    if (m === 60) { h += 1; m = 0; }
    if (h === 24) { d += 1; h = 0; }
    var parts = [];
    if (d) parts.push(fill(t('days'), { n: d }));
    if (h) parts.push(fill(t('hours'), { n: h }));
    if (m) parts.push(fill(t('minutes'), { n: m }));
    return parts.length ? parts.join('') : t('resetsSoon');
  }

  // ── Value formatting / numeric guards ──────────────────────────────────
  // Money is formatted from the payload's ISO currency code, so a provider
  // reporting USD is never drawn with a ¥ sign. The narrowSymbol display
  // keeps the capsule compact (zh-CN USD → "$16.24" not "US$16.24").
  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value !== 'string' || !/^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/.test(value.trim())) return NaN;
    return Number(value.trim());
  }
  function fmtMoney(amount, currency) {
    var n = numeric(amount);
    if (!Number.isFinite(n)) return '—';
    var code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
    if (!code) return n.toFixed(2);
    try {
      return new Intl.NumberFormat(LANG === 'zh' ? 'zh-CN' : 'en-US', {
        style: 'currency', currency: code, currencyDisplay: 'narrowSymbol'
      }).format(n);
    } catch (e) {
      return n.toFixed(2) + ' ' + code; // unknown ISO code → never throw in a render path
    }
  }
  function fmtCount(value) {
    var n = numeric(value);
    return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
  }
  function fmtCompact(value) {
    var n = numeric(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1e3) return String(Math.round(n));
    if (n < 1e6) return (n / 1e3).toFixed(1) + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(1) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  }
  // Numeric guard for provider payloads: a non-finite reading is INVALID data,
  // never a silent 0. Finite readings are clamped for display only.
  function clampPct(value) {
    var n = numeric(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.min(Math.max(n, 0), 100);
  }
  function pctText(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return (Math.round(n * 10) / 10) + '%';
  }
  // Wall-clock stamp for the stale tooltip ("更新于 15:32").
  function fmtClock(ms) {
    var d = new Date(ms);
    if (!isFinite(d.getTime())) return '';
    var pad = function (v) { return (v < 10 ? '0' : '') + v; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  // Command Code reports window resets as epoch milliseconds while the other
  // providers send ISO strings; normalize both, and never throw on garbage.
  function resetIso(value) {
    if (typeof value === 'string') return value;
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    var d = new Date(n);
    return isFinite(d.getTime()) ? d.toISOString() : undefined;
  }

  // ── Provider renderer registry ─────────────────────────────────────────
  // One adapter per format. Each adapter owns response parsing + status
  // derivation + the derived model used by BOTH the compact capsule and the
  // expanded card, so DOM rendering stays decoupled from provider response
  // shapes. Adding a provider = adding an adapter; config format unchanged.
  var PROVIDER_RENDERERS = {
    'deepseek-balance': {
      kind: 'balance',
      // compact text for one provider value
      compactValue: function (model) { return model ? model.value : '—'; },
      // derive { status, summary } from parsed data
      deriveState: function (data, spec, helpers) {
        var info = data && data.balance_infos && data.balance_infos[0];
        if (!info) return { valid: false, status: 'error', title: 'no balance info' };
        var total = numeric(info.total_balance);
        if (!Number.isFinite(total)) return { valid: false, status: 'error', title: 'non-numeric total_balance' };
        // Currency comes from the payload, not from the renderer: a CNY account
        // renders ¥ and a USD account renders $, in both UI languages.
        var currency = typeof info.currency === 'string' && info.currency ? info.currency : 'CNY';
        var money = helpers.fmtMoney(total, currency);
        var tiers = spec.balanceTiers || { critical: 10, warn: 20, healthy: 50 };
        var status;
        if (total <= tiers.critical) status = 'error';
        else if (total <= tiers.warn) status = 'warn';
        else status = 'ok';
        var lines = ['total: ' + money];
        if (Number.isFinite(Number(info.granted_balance))) lines.push('granted: ' + helpers.fmtMoney(info.granted_balance, currency));
        if (Number.isFinite(Number(info.topped_up_balance))) lines.push('topped-up: ' + helpers.fmtMoney(info.topped_up_balance, currency));
        return {
          valid: true,
          status: status,
          summary: money,
          value: money,
          balanceDetails: [['充值余额', numeric(info.topped_up_balance)], ['赠送余额', numeric(info.granted_balance)]].map(function (entry) { return { label: entry[0], value: Number.isFinite(entry[1]) ? helpers.fmtMoney(entry[1], currency) : '—' }; }),
          tier: total <= tiers.critical ? 'recharge' : total <= tiers.warn ? 'tight' : total <= tiers.healthy ? 'ok' : 'surplus',
          title: lines.join('\\n')
        };
      },
      // filled into the expanded-card balance view
      detailModel: function (model) { return model; }
    },
    'opencode-usage': {
      kind: 'usage',
      compactValue: function (model) { return model ? model.summary : '—'; },
      deriveState: function (data, spec, helpers) {
        var u = data && data.usage;
        if (!u || !u.rolling || !u.weekly || !u.monthly) return { valid: false, status: 'error', title: 'usage windows missing' };
        // A malformed window is reported as invalid data rather than folded to
        // 0% — silently reading a broken reading as "plenty left" is the one
        // failure mode a quota widget must never have.
        var rp = helpers.clampPct(u.rolling.percent);
        var wp = helpers.clampPct(u.weekly.percent);
        var mp = helpers.clampPct(u.monthly.percent);
        if (rp === undefined || wp === undefined || mp === undefined) return { valid: false, status: 'error', title: 'non-numeric usage percent' };
        var high = Math.max(rp, wp, mp);
        var status;
        if (high >= spec.errorPercent) status = 'error';
        else if (high >= spec.warnPercent) status = 'warn';
        else status = 'ok';
        var labels = helpers.windowLabels(spec);
        return {
          valid: true,
          status: status,
          summary: high + '%',
          usageText: labels.rolling + ' ' + rp + '%' + ' · ' + labels.weekly + ' ' + wp + '%' + ' · ' + labels.monthly + ' ' + mp + '%',
          high: high,
          windows: [['rolling', '5小时'], ['weekly', '周'], ['monthly', '月']].map(function (entry) { var v = u[entry[0]]; return { label: entry[1], percent: helpers.clampPct(v.percent), reset: v.resetsAt }; }),
          progressPct: high,
          caption: helpers.fill(helpers.t('usageCaption'), { h: high }),
          title: 'rolling: ' + rp + '%（' + helpers.t('resetsAt') + ' ' + helpers.fmtReset(u.rolling.resetsAt) + '）' + '\\nweekly: ' + wp + '%（' + helpers.t('resetsAt') + ' ' + helpers.fmtReset(u.weekly.resetsAt) + '）' + '\\nmonthly: ' + mp + '%（' + helpers.t('resetsAt') + ' ' + helpers.fmtReset(u.monthly.resetsAt) + '）'
        };
      },
      detailModel: function (model) { return model; }
    },
    // Command Code: the row headlines the billing-period SPEND (usage.totalCost,
    // in the same unit as the credits) and meters it against the period
    // allowance reconstructed as spend + remaining credits.
    'command-cost': {
      kind: 'cost',
      compactValue: function (model) { return model ? model.summary : '—'; },
      deriveState: function (data, spec, helpers) {
        var usage = data && data.usage;
        if (!usage) return { valid: false, status: 'error', title: 'cost summary missing' };
        var cost = numeric(usage.totalCost);
        if (!Number.isFinite(cost) || cost < 0) return { valid: false, status: 'error', title: 'non-numeric usage.totalCost' };
        var currency = spec.currency || 'USD';
        var money = helpers.fmtMoney(cost, currency);
        var credits = data.credits || {};
        var remaining = 0;
        var haveRemaining = false;
        var pools = ['monthlyCredits', 'purchasedCredits', 'freeCredits'];
        for (var p = 0; p < pools.length; p++) {
          var pool = numeric(credits[pools[p]]);
          if (Number.isFinite(pool) && pool >= 0) { remaining += pool; haveRemaining = true; }
        }
        // The allowance is never reported directly; spend + what is left of the
        // period pool reconstructs it (GOAT refills $70/month: 16.24 + 53.77).
        var allowance = haveRemaining ? cost + remaining : undefined;
        var periodPct = allowance > 0 ? helpers.clampPct((cost / allowance) * 100) : undefined;
        var limits = data.windowLimits || {};
        var labels = helpers.windowLabels(spec);
        var captionParts = [];
        var titleLines = [helpers.t('costSpend') + ': ' + money];
        var monthlyUsed = numeric(usage.totalMonthlyCredits);
        var monthlyRemaining = numeric(credits.monthlyCredits);
        var monthlyPct = usage.periodBasis === 'billing-period' && monthlyUsed >= 0 && monthlyRemaining >= 0 && monthlyUsed + monthlyRemaining > 0
          ? helpers.clampPct(monthlyUsed / (monthlyUsed + monthlyRemaining) * 100) : undefined;
        var high = monthlyPct;
        var detailWindows = [];
        if (periodPct !== undefined) captionParts.push(helpers.t('winPeriod') + ' ' + helpers.pctText(periodPct));
        var windows = [['fiveHour', labels.fiveHour, limits.fiveHour], ['weekly', labels.weekly, limits.weekly]];
        for (var w = 0; w < windows.length; w++) {
          var name = windows[w][0];
          var label = windows[w][1];
          var source = windows[w][2] || {};
          var used = numeric(source.used);
          var cap = numeric(source.cap);
          if (!Number.isFinite(used) || used < 0 || !Number.isFinite(cap) || cap <= 0) {
            detailWindows.push({ label: name === 'fiveHour' ? '5小时' : '周', percent: undefined, reset: helpers.resetIso(source.resetAt) });
            continue;
          }
          var usedPct = helpers.clampPct((used / cap) * 100);
          detailWindows.push({ label: name === 'fiveHour' ? '5小时' : '周', percent: usedPct, reset: helpers.resetIso(source.resetAt) });
          if (usedPct === undefined) continue;
          captionParts.push(label + ' ' + helpers.pctText(usedPct));
          if (high === undefined || usedPct > high) high = usedPct;
          titleLines.push(name + ': ' + used + ' / ' + cap + '（' + helpers.t('resetsAt') + ' ' + helpers.fmtReset(helpers.resetIso(source.resetAt)) + '）');
        }
        var subParts = [];
        detailWindows.push({ label: '月', percent: monthlyPct, reset: undefined });
        if (Number.isFinite(Number(usage.totalCount))) subParts.push(helpers.fill(helpers.t('costRequests'), { n: helpers.fmtCount(usage.totalCount) }));
        if (Number.isFinite(Number(usage.totalTokens))) subParts.push(helpers.fmtCompact(usage.totalTokens) + ' tokens');
        if (haveRemaining) subParts.push(helpers.fill(helpers.t('costRemaining'), { v: helpers.fmtMoney(remaining, currency) }));
        var status = high === undefined ? 'unknown' : 'ok';
        if (high !== undefined) {
          if (high >= spec.errorPercent) status = 'error';
          else if (high >= spec.warnPercent) status = 'warn';
        }
        titleLines.push(subParts.join(' · '));
        if (Number.isFinite(Number(usage.averageCost))) titleLines.push('avg: ' + helpers.fmtMoney(usage.averageCost, currency));
        if (haveRemaining) titleLines.push(helpers.t('costPool') + ': ' + helpers.fmtMoney(remaining, currency) + ' / ' + helpers.fmtMoney(allowance, currency));
        return {
          valid: true,
          status: status,
          summary: high === undefined ? '—' : helpers.pctText(high),
          value: money,
          windows: detailWindows,
          balanceDetails: [{ label: '本期费用', value: money }, { label: '剩余额度', value: haveRemaining ? helpers.fmtMoney(remaining, currency) : '—' }],
          sub: subParts.join(' · '),
          high: high,
          progressPct: high === undefined ? 0 : high,
          caption: captionParts.join(' · '),
          title: titleLines.join('\\n')
        };
      },
      detailModel: function (model) { return model; }
    }
  };
  function rendererFor(spec) { return PROVIDER_RENDERERS[spec.format] || null; }
  /** Renderer kind, used to pick the row layout ("balance" when unknown). */
  function kindOf(spec) {
    var renderer = rendererFor(spec);
    return renderer ? renderer.kind : 'balance';
  }

  function readingHint(spec, state) {
    var meaning = kindOf(spec) === 'balance' ? (LANG === 'zh' ? '余额' : 'balance')
      : (LANG === 'zh' ? '最高周期用量' : 'highest window usage');
    return spec.label + ' ' + meaning + ': ' + (state ? state.summary : '…')
      + (state && state.status === 'error' ? (LANG === 'zh' ? ' · 额度告警' : ' · quota alert') : '')
      + (state && state.hint ? '\\n' + state.hint : '');
  }

  function renderCapsule() {
    for (var i = 0; i < ROWS.length; i++) {
      var spec = ROWS[i];
      var s = STATE[spec.id];
      var dot = CAPSULE_DOTS[spec.id];
      var valueEl = CAPSULE_VALUES[spec.id];
      if (!dot || !valueEl) continue;
      var status = s ? s.status : 'loading';
      dot.className = 'dsh-capsule-dot state-' + status;
      valueEl.className = 'dsh-capsule-item state-' + status;
      var model = LASTMODEL[spec.id] && LASTMODEL[spec.id].model;
      var shortValue = s ? s.summary : '…';
      if (kindOf(spec) === 'balance' && model) shortValue = model.value.replace(/([0-9]+)[.][0-9]+/, '$1');
      if (kindOf(spec) !== 'balance' && model && model.high !== undefined) shortValue = Math.round(model.high) + '%';
      valueEl.textContent = shortValue;
      valueEl.parentElement.title = readingHint(spec, s);
      var detailValue = DETAIL_VALUES[spec.id];
      if (detailValue) {
        detailValue.className = 'dsh-quota-detail-value state-' + status;
        detailValue.replaceChildren();
        if (model) {
          if (kindOf(spec) === 'balance') detailValue.appendChild(el('span', 'quota-balance', model.value));
          (model.windows || []).forEach(function (win) {
            var row = el('span', 'quota-window');
            var line = el('span', 'quota-line');
            line.appendChild(el('span', '', win.label));
            line.appendChild(el('span', '', win.percent === undefined ? '—' : pctText(win.percent) + ' 已用'));
            row.appendChild(line);
            var track = el('span', 'quota-track');
            var fillEl = el('span', 'quota-fill');
            if (win.percent !== undefined) fillEl.style.width = win.percent + '%';
            track.appendChild(fillEl); row.appendChild(track);
            row.appendChild(el('span', 'quota-reset', win.reset && Number.isFinite(new Date(win.reset).getTime()) ? fmtReset(win.reset) + '后重置' : (win.label === '月' && kindOf(spec) === 'cost' ? '本期月度额度' : '重置时间 —')));
            detailValue.appendChild(row);
          });
          (kindOf(spec) === 'balance' ? [] : model.balanceDetails || []).forEach(function (entry) {
            var line = el('span', 'quota-line quota-money');
            line.appendChild(el('span', '', entry.label)); line.appendChild(el('span', '', entry.value));
            detailValue.appendChild(line);
          });
        } else detailValue.appendChild(el('span', '', s ? '—' : '…'));
        detailValue.parentElement.title = readingHint(spec, s);
        detailValue.parentElement.dataset.state = status;
      }
    }
    updateLabel();
    anchorPanel();
  }

  function updateLabel() {
    capsuleEl.setAttribute('aria-label', (expanded ? t('ariaCollapse') : t('ariaExpand')) + ': '
      + ROWS.map(function (spec) { return readingHint(spec, STATE[spec.id]); }).join('; '));
  }

  function setExpanded(open) {
    expanded = Boolean(open);
    compactEl.hidden = expanded;
    detailEl.hidden = !expanded;
      lockEl.hidden = !expanded;
    if (refreshEl) refreshEl.hidden = !expanded;
    panelEl.classList.toggle('is-expanded', expanded);
    capsuleEl.setAttribute('aria-expanded', String(expanded));
    updateLabel();
    anchorPanel();
    if (!expanded && document.activeElement === lockEl) capsuleEl.focus();
    if (open) refreshAll();
  }

  function setLocked(next) {
    locked = Boolean(next);
    if (drag) onDragEnd();
    try { localStorage.setItem('dsh.quota.locked', locked ? '1' : '0'); } catch (e) { /* ignore */ }
    if (lockEl) {
      lockEl.setAttribute('aria-pressed', String(locked));
      lockEl.setAttribute('aria-label', LANG === 'zh' ? (locked ? '解锁位置' : '锁定位置') : (locked ? 'Unlock position' : 'Lock position'));
      lockEl.title = lockEl.getAttribute('aria-label');
    }
    if (panelEl) panelEl.classList.toggle('is-locked', locked);
  }

  // Render one provider's data into its view via its registered renderer in
  // PROVIDER_RENDERERS. The payload is the server's normalized envelope:
  // ok+data on success, or ok=false with an error code/status/message.
  //
  // Failure policy: an unhealthy provider must not erase a reading we already
  // have. The last good model stays on screen (grey, hollow dot) with the
  // refresh failure + its timestamp in the tooltip; only a provider that has
  // never produced a reading shows the red "unavailable" row.
  function applyRender(spec, payload) {
    var renderer = rendererFor(spec);
    var helpers = {
      t: t,
      fill: fill,
      windowLabels: windowLabels,
      fmtReset: fmtReset,
      fmtMoney: fmtMoney,
      fmtCount: fmtCount,
      fmtCompact: fmtCompact,
      clampPct: clampPct,
      pctText: pctText,
      resetIso: resetIso
    };
    var data = payload && payload.ok ? payload.data : null;
    var failure = payload && !payload.ok ? (payload.error || {}) : null;
    var model = data && renderer ? renderer.deriveState(data, spec, helpers) : null;
    if (model && model.valid === true) {
      LASTMODEL[spec.id] = { model: model, at: Date.now() };
      STATE[spec.id] = { status: model.status, summary: model.summary };
      renderCapsule();
      return;
    }
    var reason = failure
      ? ((failure.code || 'error') + (failure.status ? ' ' + failure.status : '') + (failure.message ? ': ' + failure.message : ''))
      : ((model && model.title) || 'unusable payload');
    var previous = LASTMODEL[spec.id];
    if (previous) {
      var at = fmtClock(previous.at);
      var updated = fill(t('staleUpdated'), { time: at });
      STATE[spec.id] = {
        status: 'stale',
        summary: previous.model.summary,
        hint: updated + '\\n' + fill(t('staleUnavailable'), { label: spec.label }) + '\\n' + reason
      };
      renderCapsule();
      return;
    }
    STATE[spec.id] = { status: 'unknown', summary: '—', hint: reason };
    renderCapsule();
  }

  // Position always refers to the 28px shell, not the animated button.
  // Expanding grows upward from its bottom edge. v1 saved positions survive.
  var POS_KEY = 'dsh.quota.pos';
  var PANEL_H = 28;
  var DRAG_SLOP = 4;
  var EDGE_PAD = 8;
  var pos = null;
  var drag = null;
  var didDrag = false;

  function readPos() {
    try {
      var raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        return { x: saved.x, y: saved.y };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function savePos(next) {
    try {
      if (next) localStorage.setItem(POS_KEY, JSON.stringify({ v: 1, x: Math.round(next.x), y: Math.round(next.y) }));
      else localStorage.removeItem(POS_KEY);
    } catch (e) { /* ignore */ }
  }

  function clampToViewport(candidate) {
    var scale = panelEl.getBoundingClientRect().width / panelEl.offsetWidth || 1;
    var minY = EDGE_PAD + Math.max(0, capsuleEl.offsetHeight - 28);
    var maxX = Math.max(EDGE_PAD, window.innerWidth / scale - panelEl.offsetWidth - EDGE_PAD);
    var maxY = Math.max(minY, window.innerHeight / scale - 28 - EDGE_PAD);
    return {
      x: Math.min(Math.max(EDGE_PAD, candidate.x), maxX),
      y: Math.min(Math.max(minY, candidate.y), maxY)
    };
  }

  function anchorPanel() {
    if (!panelEl || !capsuleEl) return;
    panelEl.style.setProperty('--quota-detail-height', capsuleEl.offsetHeight + 'px');
    if (mountSlot && !mountSlot.isConnected) {
      mountSlot = null;
      document.body.appendChild(panelEl);
    }
    panelEl.classList.toggle('is-hosted', Boolean(mountSlot));
    if (mountSlot) {
      panelEl.style.left = '';
      panelEl.style.top = '';
      return;
    }
    var defaultPos = { x: 24, y: window.innerHeight - 92 };
    // Anchor on the host's settings row so the default position clears it.
    // The row's own [data-slot="settings.trigger"] wrapper has no box on some
    // host builds, so fall back to the visible label and walk up to the first
    // ancestor that does have one.
    var footer = document.querySelector('[data-slot="settings.trigger"]');
    if (!footer || !footer.getBoundingClientRect().width) {
      var footerLabel = null;
      var labelNodes = document.querySelectorAll('span,div,button,a,p');
      for (var li = 0; li < labelNodes.length && !footerLabel; li++) {
        var node = labelNodes[li];
        var text = node.children.length === 0 ? node.textContent.trim() : '';
        if (text === '设置' || text === 'Settings') footerLabel = node;
      }
      footer = footerLabel;
      while (footer && footer !== document.body) {
        var fr = footer.getBoundingClientRect();
        if (fr.width > 0 && fr.height > 0) break;
        footer = footer.parentElement;
      }
      if (footer === document.body) footer = footerLabel;
    }
    if (footer) {
      var footerRect = footer.getBoundingClientRect();
      if (footerRect.width > 0 && footerRect.left < window.innerWidth / 2) defaultPos.y = footerRect.top - Math.max(0, capsuleEl.offsetHeight - PANEL_H) - PANEL_H - 12;
    }
    var clamped = clampToViewport(pos || defaultPos);
    panelEl.style.left = Math.round(clamped.x) + 'px';
    panelEl.style.top = Math.round(clamped.y) + 'px';
  }

  function resetPos() {
    mountSlot = null;
    document.body.appendChild(panelEl);
    pos = null;
    savePos(null);
    anchorPanel();
  }

  function onDragStart(event) {
    if (locked || drag || event.button !== 0 || !event.isPrimary) return;
    didDrag = false;
    var rect = panelEl.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false
    };
    try { capsuleEl.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    var dx = event.clientX - drag.startX;
    var dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
    if (!drag.moved) {
      drag.moved = true;
      if (mountSlot) {
        mountSlot = null;
        document.body.appendChild(panelEl);
        panelEl.classList.remove('is-hosted');
      }
      panelEl.classList.add('is-dragging');
    }
    event.preventDefault();
    pos = clampToViewport({ x: drag.originX + dx, y: drag.originY + dy });
    anchorPanel();
  }

  function onDragEnd(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    var ended = drag;
    drag = null;
    try { capsuleEl.releasePointerCapture(ended.id); } catch (e) { /* ignore */ }
    panelEl.classList.remove('is-dragging');
    if (ended.moved) {
      didDrag = true;
      savePos(pos);
      // Only swallow the click generated by this pointer release.
      setTimeout(function () { didDrag = false; }, 0);
    }
  }

  function installDrag() {
    capsuleEl.addEventListener('pointerdown', onDragStart);
    capsuleEl.addEventListener('pointermove', onDragMove);
    capsuleEl.addEventListener('pointerup', onDragEnd);
    capsuleEl.addEventListener('pointercancel', onDragEnd);
    capsuleEl.addEventListener('lostpointercapture', onDragEnd);
    // Right-click on the handle restores the default corner — the escape hatch
    // for a widget dragged somewhere awkward (or off a resized screen).
    capsuleEl.addEventListener('contextmenu', function (event) {
      if (locked) return;
      event.preventDefault();
      resetPos();
    });
  }

  function injectStyles() {
    var style = el('style');
    style.id = 'dsh-quota-style';
    style.textContent = ${JSON.stringify(CAPSULE_CSS).replace(/</g, '\\u003C')};
    document.head.appendChild(style);
  }

  function createPanel() {
    var panel = el('div');
    panel.id = panelId;
    panel.dataset.version = VERSION;
    panel.style.setProperty('--quota-columns', String(Math.max(1, ROWS.length)));

    // Collapsed capsule: one dot + value pair per provider, no text labels.
    capsuleEl = el('button', 'dsh-quota-capsule');
    capsuleEl.id = capsuleId;
    capsuleEl.type = 'button';
    capsuleEl.setAttribute('aria-label', t('ariaExpand'));
    capsuleEl.setAttribute('aria-expanded', 'false');
    capsuleEl.setAttribute('aria-controls', cardId);
    compactEl = el('span', 'dsh-quota-compact-row');
    compactEl.id = 'dsh-quota-compact-row';
    for (var i = 0; i < ROWS.length; i++) {
      var spec = ROWS[i];
      var dot = el('span', 'dsh-capsule-dot state-loading');
      var valueEl = el('span', 'dsh-capsule-item state-loading', '…');
      CAPSULE_DOTS[spec.id] = dot;
      CAPSULE_VALUES[spec.id] = valueEl;
      var pair = el('span', 'dsh-capsule-pair');
      pair.appendChild(dot);
      pair.appendChild(valueEl);
      compactEl.appendChild(pair);
    }
    capsuleEl.appendChild(compactEl);
    capsuleEl.addEventListener('click', function () {
      if (didDrag) { didDrag = false; return; }
      setExpanded(!expanded);
    });
    installDrag();
    panel.appendChild(capsuleEl);

    detailEl = el('span', 'dsh-quota-detail-grid');
    detailEl.id = cardId;
    detailEl.hidden = true;
    for (var i = 0; i < ROWS.length; i++) {
      var detailColumn = el('span', 'dsh-quota-detail-column');
      if (kindOf(ROWS[i]) === 'balance') detailColumn.classList.add('is-balance');
      var shortName = ROWS[i].label.replace(/^OpenCode Go$/i, 'OpenCode').replace(/^Command Code$/i, 'CommandCode');
      detailColumn.appendChild(el('span', 'dsh-quota-detail-name', shortName));
      var detailValue = el('span', 'dsh-quota-detail-value state-loading', '…');
      DETAIL_VALUES[ROWS[i].id] = detailValue;
      detailColumn.appendChild(detailValue);
      detailEl.appendChild(detailColumn);
    }
    capsuleEl.appendChild(detailEl);
    lockEl = el('button', 'dsh-quota-lock');
    lockEl.id = 'dsh-quota-lock';
    lockEl.type = 'button';
    lockEl.hidden = true;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    ['M5 7V5a3 3 0 0 1 6 0v2', 'M4 7h8v7H4z', 'M8 10v1.5'].forEach(function (path, index) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('d', path);
      if (index === 0) node.setAttribute('class', 'lock-shackle');
      svg.appendChild(node);
    });
    lockEl.appendChild(svg);
    lockEl.addEventListener('click', function () { setLocked(!locked); });
    panel.appendChild(lockEl);
    refreshEl = el('button', 'dsh-quota-refresh');
    refreshEl.id = 'dsh-quota-refresh';
    refreshEl.type = 'button';
    refreshEl.hidden = true;
    refreshEl.setAttribute('aria-label', LANG === 'zh' ? '刷新额度' : 'Refresh quota');
    refreshEl.title = refreshEl.getAttribute('aria-label');
    refreshEl.textContent = '↻';
    refreshEl.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      refreshEl.classList.add('is-refreshing');
      refreshAll().finally(function () { refreshEl.classList.remove('is-refreshing'); });
    });
    panel.appendChild(refreshEl);
    try { locked = localStorage.getItem('dsh.quota.locked') === '1'; } catch (e) { locked = false; }
    setLocked(locked);
    return panel;
  }

  async function refreshProvider(spec) {
    // The route always answers with the normalized envelope; a transport
    // failure or a non-JSON body is turned into the same shape here so the
    // render path only ever sees ok+data or ok=false+error.
    var payload;
    try {
      var response = await fetch('/api/quota/' + encodeURIComponent(spec.id), { cache: 'no-store', signal: AbortSignal.timeout(35000) });
      var text = await response.text();
      try {
        payload = JSON.parse(text);
      } catch (e) {
        payload = { ok: false, error: { code: 'invalid-body', status: response.status, message: 'non-JSON response' } };
      }
    } catch (error) {
      payload = { ok: false, error: { code: 'network', message: String(error && error.message ? error.message : error) } };
    }
    if (!payload || typeof payload !== 'object') payload = { ok: false, error: { code: 'invalid-body', message: 'empty response' } };
    applyRender(spec, payload);
  }

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      await Promise.all(ROWS.map(function (spec) { return refreshProvider(spec); }));
    } finally {
      refreshing = false;
    }
  }

  function mount() {
    if (document.getElementById(panelId)) return;
    injectStyles();
    panelEl = createPanel();
    panelEl.classList.toggle('is-locked', locked);
    pos = readPos(); // restore a dragged position before the first paint
    document.body.appendChild(panelEl);
    anchorPanel();
    // Fonts/paint land after the first layout: re-anchor once, then keep the
    // widget inside the viewport on resize.
    // Re-anchor on the next two frames: fonts and the capsule's own height land
    // after the first layout, and a default computed before that would sit on
    // the settings row. anchorPanel only re-runs the default while the user has
    // not saved a position, so a placed widget is never moved.
    requestAnimationFrame(function () {
      anchorPanel();
      requestAnimationFrame(anchorPanel);
    });
    window.addEventListener('resize', function () {
      anchorPanel();
    });
    new ResizeObserver(anchorPanel).observe(panelEl);
    // DSH loads its sidebar asynchronously; keep the default clear of its footer.
    var anchorFrame = 0;
    new MutationObserver(function (records) {
      if (pos || mountSlot || anchorFrame || !records.some(function (record) { return !panelEl.contains(record.target); })) return;
      anchorFrame = requestAnimationFrame(function () { anchorFrame = 0; anchorPanel(); });
    }).observe(document.body, { childList: true, subtree: true });
    refreshAll();
    setInterval(function () {
      if (!document.hidden) refreshAll();
    }, AUTO_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshAll();
    });
    // Esc collapses the card from anywhere (the card is not a focus trap, so
    // this is a convenience rather than an escape hatch) and hands focus back
    // to the capsule that opened it.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !panelEl || !panelEl.classList.contains('is-expanded')) return;
      setExpanded(false);
      try { capsuleEl.focus(); } catch (e) { /* ignore */ }
    });
    registerQuotaModule();
  }

  // ── Optional host-page integration (user-invisible seam) ──────────────
  // Runs after mount so the DOM (capsule, card, state) exists. Registered
  // only when the neutral runtime is present; never affects standalone use.
  function registerQuotaModule() {
    try {
      var rt = window.DSH_PLUGIN_INTEGRATION_V1;
      if (!rt) return;
      rt.register({
        id: 'quota',
        kind: 'resource',
        title: 'Quota',
        getSnapshot: function () {
          var rows = ROWS.map(function (spec) {
            var s = STATE[spec.id] || { status: 'loading', summary: '…' };
            var last = LASTMODEL[spec.id];
            return {
              id: spec.id,
              label: spec.label,
              format: spec.format,
              status: s.status,
              summary: s.summary,
              // A stale row still reports the reading it could last confirm, so
              // a consumer can tell "value is old" from "value is unknown".
              observedAt: last ? last.at : null
            };
          });
          // Stale/loading rows are excluded from the aggregate level: one failed
          // refresh is not an account problem, and when nothing has ever been
          // read the honest answer is "unknown".
          var levels = rows
            .map(function (r) { return r.status; })
            .filter(function (status) { return status !== 'stale' && status !== 'loading' && status !== 'unknown'; });
          var level = levels.indexOf('error') >= 0 ? 'error' : (levels.indexOf('warn') >= 0 ? 'warn' : (levels.length ? 'ok' : 'unknown'));
          var times = rows.map(function (r) { return r.observedAt || 0; });
          return { level: level, providers: rows, updatedAt: Math.max.apply(Math, [0].concat(times)) || null };
        },
        actions: {
          refresh: function () { refreshAll(); }
        },
        mountCompact: function (container) {
          // An optional host may provide a slot. A user's saved placement wins.
          if (!container || !container.isConnected || panelEl.contains(container) || pos) return;
          mountSlot = container;
          container.appendChild(panelEl);
          setExpanded(false);
        },
        unmountCompact: function () {
          if (!panelEl) return;
          mountSlot = null;
          document.body.appendChild(panelEl);
          setExpanded(false);
        },
        openDetail: function () {
          setExpanded(true);
        }
      });
    } catch { /* an exception here must never break the widget */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();`;
	// The integration runtime is prepended to the page script first. A stable
	// marker separates it from the widget IIFE so tooling/tests can locate the
	// latter robustly (the runtime contains its own IIFEs).
	return `${INTEGRATION_RUNTIME}
/*QUOTA_PAGE_SCRIPT_START*/
${script}`;
}

/** Wrap the page-script body as markup (the `webServer.tapIndex` carrier). */
function pageScriptMarkup(body) {
	return `<script>${body}<\/script>`;
}

/** Fetch-shaped JSON response for the carrier-neutral route. */
function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/**
 * Register one exact `/api/quota/<id>` Fetch route per provider on the
 * connection registry. In the Web surface the connection service mounts this
 * registry under the server's `/api` prefix; the Desktop host pipes its own
 * `/api` requests into the same registry — one registration, both carriers.
 */
function mountFetchCarrier(ctx, connection, providers) {
	providers.forEach((provider) => {
		connection.fetch.register({
			path: `/api/quota/${provider.id}`,
			methods: ['GET'],
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'GET') return jsonResponse(405, errorEnvelope(405, 'method', 'method not allowed'));
				const { status, body } = await readProvider(ctx, provider);
				return jsonResponse(status, body);
			}
		});
	});
}

/**
 * Legacy carrier: one exact route per provider on the Web server route table,
 * plus the raw index tap. Used by hosts whose connection service exposes no
 * Fetch registry; the returned function disposes both.
 */
function mountWebServerCarrier(ctx, web, providers, pageScript) {
	const disposers = providers.map((provider) => {
		return web.register({
			kind: 'exact',
			path: `/api/quota/${provider.id}`,
			handler: async (req, res) => {
				if (req.method !== 'GET') {
					sendJson(res, 405, errorEnvelope(405, 'method', 'method not allowed'));
					return;
				}
				const { status, body } = await readProvider(ctx, provider);
				sendJson(res, status, body);
			}
		});
	});
	const disposeTap = web.tapIndex((html) => html.replace('</body>', `${pageScriptMarkup(pageScript)}</body>`));
	return () => {
		for (const dispose of disposers) dispose();
		disposeTap();
	};
}

/**
 * Apply the plugin. The page asset and the data plane are mounted on whichever
 * carrier this host provides, in this order:
 *  1. the `connection` exact Fetch registry (the Web server and the Electron
 *     Desktop host both dispatch `/api/*` into it);
 *  2. the `webServer` route table + `tapIndex` (hosts without that registry).
 * @param ctx - plugin context; the carrier is discovered, not declared.
 * @param config - raw plugin config (normalized here, no schema dependency).
 */
export function apply(ctx, config) {
	const { refreshMs, providers } = normalizeConfig(config);
	const pageScript = buildPageScript(providers.map(rowSpec), refreshMs);
	let mounted = false;

	const mount = (carrierCtx) => {
		if (mounted) return;
		const connection = carrierCtx.connection;
		if (connection && connection.fetch && typeof connection.fetch.register === 'function') {
			mounted = true;
			mountFetchCarrier(carrierCtx, connection, providers);
			// The index-injection table is emitted by the Web server's index
			// renderer and by the Desktop host's asset handler, so one
			// structured row reaches both documents.
			carrierCtx.on('webserver/index-inject', (table) => {
				if (Array.isArray(table)) table.push({ kind: 'script', placement: 'body', text: pageScript });
			});
			return;
		}
		const web = carrierCtx.webServer;
		if (web && typeof web.register === 'function' && typeof web.tapIndex === 'function') {
			mounted = true;
			carrierCtx.effect(
				() => mountWebServerCarrier(carrierCtx, web, providers, pageScript),
				'quota-panel: quota routes + index tap'
			);
		}
	};

	if (typeof ctx.inject === 'function') {
		// `ctx.inject` calls back immediately when the service already exists and
		// on arrival otherwise, so load order never decides the carrier — the
		// first one that reports a usable registry wins, and the other is ignored.
		ctx.inject(['connection'], mount);
		ctx.inject(['webServer'], mount);
	} else {
		mount(ctx);
	}
}
