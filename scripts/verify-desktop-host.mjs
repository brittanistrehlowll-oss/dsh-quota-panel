/**
 * Desktop-carrier verification (Electron path, no Electron needed).
 *
 * The Desktop app does not run an HTTP server: `dsh-desktop-host` composes the
 * same profile bundles with `web-startup` / `webserver` / `web-runtime`
 * disabled, serves index.html (plus its injected rows) from its asset handler,
 * and dispatches everything the renderer fetches over the IPC pipe —
 * `/.dsh/remote-stream`, `/api/*`, then assets.
 *
 * This script boots that exact composition in plain Node through the real
 * `runDesktopHost`, drives its request dispatcher, and asserts:
 *   1. index.html carries this plugin's injected page script;
 *   2. `/api/quota/<id>` answers the shared envelope with live readings;
 *   3. an unknown quota id is a 404, not a crash.
 *
 * Usage: node scripts/verify-desktop-host.mjs <profileDir> [runtimeDir]
 *   profileDir  a desktop profile (package.json with the desktop bundle list,
 *               plugins/quota-panel linked, cordis.patch.yml mounting the row).
 *               Copy the live one instead of pointing at it while the app runs.
 *   runtimeDir  the unpacked dsh runtime from the app
 *               (…\DeepSeek Harness\resources\dsh); defaults to
 *               $DSH_DESKTOP_RUNTIME, else the packaged install path.
 * Credentials are read from $DSH_HOME/.credentials.yaml as usual — no key ever
 * appears in the output.
 */
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const runtimeDir = process.argv[3]
	?? process.env.DSH_DESKTOP_RUNTIME
	?? 'C:\\Users\\wx\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\dsh';
if (profileDir === undefined) {
	console.error('usage: node scripts/verify-desktop-host.mjs <profileDir> [runtimeDir]');
	process.exit(2);
}
for (const [label, path] of [['profileDir', profileDir], ['runtimeDir', runtimeDir]]) {
	if (!existsSync(path)) {
		console.error(`${label} does not exist: ${path}`);
		process.exit(2);
	}
}

const FRAME_MAGIC = 1146308659;
const FRAME_HEADER_BYTES = 13;

/** Decode the host's framed byte-pipe responses into one HTTP-shaped result. */
function decode(frames) {
	const framesInOrder = [];
	let rest = Buffer.concat(frames);
	while (rest.length >= FRAME_HEADER_BYTES) {
		if (rest.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('desktop host: bad response frame marker');
		const type = rest.readUInt8(4);
		const payloadLength = rest.readUInt32BE(9);
		if (rest.length < FRAME_HEADER_BYTES + payloadLength) break;
		framesInOrder.push({ type, payload: rest.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLength) });
		rest = rest.subarray(FRAME_HEADER_BYTES + payloadLength);
	}
	const start = framesInOrder.find((frame) => frame.type === 1);
	const error = framesInOrder.find((frame) => frame.type === 4);
	return {
		status: start === undefined ? 0 : JSON.parse(start.payload.toString('utf8')).status,
		body: Buffer.concat(framesInOrder.filter((frame) => frame.type === 2).map((frame) => frame.payload)).toString('utf8'),
		error: error === undefined ? null : JSON.parse(error.payload.toString('utf8')).message
	};
}

const hostUrl = pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')).href;
const { runDesktopHost } = await import(hostUrl);

const frames = [];
const controller = await runDesktopHost(runtimeDir, profileDir, async (frame) => { frames.push(frame); }, {});
console.log(`desktop host: dsh ${controller.dshVersion} · profile ${profileDir}`);
console.log(`runtime:      ${runtimeDir}`);

let streamId = 0;
async function request(path) {
	frames.length = 0;
	await controller.fetch({ streamId: ++streamId, request: { url: `dsh-app://app${path}`, method: 'GET', headers: [] } }, null);
	return decode(frames);
}

let failures = 0;
const check = (name, pass, detail = '') => {
	console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
	if (!pass) failures += 1;
};

const index = await request('/');
check('asset handler serves index.html', index.status === 200 && index.body.includes('<html'), `status=${index.status} bytes=${index.body.length}`);
check('index.html carries the injected page script', index.body.includes('/*QUOTA_PAGE_SCRIPT_START*/'));
check('index.html carries the integration runtime', index.body.includes('DSH_PLUGIN_INTEGRATION_V1'));
const bodyAt = index.body.indexOf('<body');
const markerAt = index.body.indexOf('/*QUOTA_PAGE_SCRIPT_START*/');
check('the injection row renders inside <body>', bodyAt !== -1 && markerAt > bodyAt, `body=${bodyAt} marker=${markerAt}`);

for (const id of ['deepseek', 'opencode-go', 'command']) {
	const res = await request(`/api/quota/${id}`);
	let parsed = null;
	try { parsed = JSON.parse(res.body); } catch { /* left null */ }
	check(`/api/quota/${id} answers the shared envelope`, res.status === 200 && parsed?.ok === true, `status=${res.status} ${res.error ?? ''} ${res.body.slice(0, 110)}`);
}
const missing = await request('/api/quota/unknown-provider');
check('an unknown quota id is a 404', missing.status === 404, `status=${missing.status}`);

await controller.dispose();
console.log(failures === 0 ? '\nall desktop-carrier checks passed' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
