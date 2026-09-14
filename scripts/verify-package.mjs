// Release gate: prove the packed tarball is self-sufficient.
//
// `npm pack` only ships the `files` whitelist, and this plugin reads
// lib/plugin-integration-v1.js from disk at import time — a file missing from
// the whitelist would break every consumer while every working-tree test still
// passes. So this script packs, extracts, and then loads the plugin FROM THE
// EXTRACTED COPY, running the same contract checks a consumer would hit.
//
// Usage: node scripts/verify-package.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

let failures = 0;
const check = (name, pass, detail = '') => {
	console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
	if (!pass) failures += 1;
};

const run = (command, args, cwd) => {
	// stdio inherited on purpose: capturing a child's output through a pipe is
	// blocked under restricted stdio sandboxes. On Windows `npm` is a `.cmd`
	// shim, which Node refuses to spawn without a shell — so the whole command
	// goes in as ONE pre-quoted string (passing an args array alongside
	// `shell` is both deprecated and an injection foot-gun).
	const line = [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
	const result = spawnSync(line, { cwd, stdio: 'inherit', shell: true });
	if (result.status !== 0) {
		console.error(`FAIL: ${line} exited ${result.status}`);
		process.exit(1);
	}
};

const workDir = mkdtempSync(path.join(tmpdir(), 'dsh-quota-pack-'));
console.log(`packing ${pkg.name}@${pkg.version} into ${workDir}\n`);
run('npm', ['pack', '--pack-destination', workDir], pkgDir);

const tarball = readdirSync(workDir).find((name) => name.endsWith('.tgz'));
check('pack produced a tarball', Boolean(tarball), tarball);
if (!tarball) process.exit(1);

run('tar', ['-xzf', path.join(workDir, tarball), '-C', workDir], workDir);
const root = path.join(workDir, 'package');

// ── The tarball must contain everything the plugin reads at runtime ─────
const required = ['package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/plugin-integration-v1.js', 'lib/capsule.css', 'cordis.patch.yml'];
for (const relative of required) {
	check(`tarball contains ${relative}`, existsSync(path.join(root, relative)));
}
check('tarball ships no dev-only files (scripts/ docs/ demo)', !existsSync(path.join(root, 'scripts')) && !existsSync(path.join(root, 'docs')));

// ── Load the plugin from the extracted copy, not the working tree ──────
const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href);
check('extracted lib/index.js imports cleanly (integration runtime present)', typeof plugin.apply === 'function' && plugin.name === 'quota-panel');

const routes = [];
const taps = [];
plugin.apply({
	credentials: { resolve: async () => ({ value: 'k' }) },
	webServer: {
		register: (route) => { routes.push(route.path); return () => {}; },
		tapIndex: (fn) => { taps.push(fn); return () => {}; }
	},
	effect: (fn) => { fn(); return () => {}; }
}, {
	refreshMs: 60000,
	providers: [
		{ id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' },
		{ id: 'opencode-go', label: 'OpenCode Go', credential: 'OPENCODE_GO_API_KEY', endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage' },
		{ id: 'command', label: 'Command Code', credential: 'COMMAND_API_KEY', endpoint: 'https://api.commandcode.ai', format: 'command-cost' }
	]
});
check('three proxy routes registered', routes.length === 3, routes.join(', '));

const injected = taps[0]('</body>');
check('injected bundle carries the integration runtime', injected.includes('DSH_PLUGIN_INTEGRATION_V1'));
check('injected bundle carries all three renderers',
	['deepseek-balance', 'opencode-usage', 'command-cost'].every((format) => injected.includes(format)));
check('injected bundle uses the normalized envelope', injected.includes('payload.ok'));
check('package embeds compact and expanded detail stylesheet', injected.includes('height: 34px') && injected.includes('.quota-window'));
check('package includes native lock control', injected.includes("lockEl = el('button'"));

const marker = '/*QUOTA_PAGE_SCRIPT_START*/';
const markerAt = injected.indexOf(marker);
const start = injected.indexOf('(function () {', markerAt);
const end = injected.lastIndexOf('})();');
try {
	new vm.Script(injected.slice(start, end + '})();'.length));
	check('page script from the tarball parses', true);
} catch (error) {
	check('page script from the tarball parses', false, String(error.message));
}

// ── The shipped bundle patch must configure the third provider ─────────
const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
check('shipped cordis.patch.yml configures command-cost', /format:\s*command-cost/.test(patch) && /COMMAND_API_KEY/.test(patch));
check('shipped cordis.patch.yml keeps OpenCode on percentages', /format:\s*opencode-usage/.test(patch) && !/format:\s*command-cost[\s\S]*opencode-usage/.test(patch));

rmSync(workDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? `tarball OK: ${tarball}` : `${failures} CHECK(S) FAILED`}`);
if (failures) process.exit(1);
