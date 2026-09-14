// Resolve a Chromium binary for the CDP-driven scripts (verify, verify-drag,
// shoot). Resolution order:
//
//   1. CHROME_PATH or CHROME_BIN — an explicit override, either spelling
//   2. the usual Chrome / Chromium / Edge install locations for this platform
//   3. chrome / chromium / msedge on PATH (resolved with fs, not a spawned
//      `which`, so this works under a restricted stdio sandbox)
//
// Fails with a readable message instead of an ENOENT from inside spawn, and
// accepts Edge because a headless-CDP script does not care which brand of
// Chromium it drives.
import { existsSync } from 'node:fs';
import path from 'node:path';

const LOCAL = process.env.LOCALAPPDATA ?? '';
const PROGRAM_FILES = process.env['ProgramFiles'] ?? 'C:/Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)';

const CANDIDATES = {
	win32: [
		path.join(PROGRAM_FILES, 'Google/Chrome/Application/chrome.exe'),
		path.join(PROGRAM_FILES_X86, 'Google/Chrome/Application/chrome.exe'),
		...(LOCAL ? [path.join(LOCAL, 'Google/Chrome/Application/chrome.exe')] : []),
		path.join(PROGRAM_FILES, 'Microsoft/Edge/Application/msedge.exe'),
		path.join(PROGRAM_FILES_X86, 'Microsoft/Edge/Application/msedge.exe')
	],
	darwin: [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
	],
	linux: [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/usr/bin/microsoft-edge',
		'/usr/bin/microsoft-edge-stable'
	]
};

const PATH_NAMES = {
	win32: ['chrome.exe', 'msedge.exe'],
	darwin: ['Google Chrome', 'Chromium', 'Microsoft Edge'],
	linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
};

function fromPath() {
	const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
	for (const name of PATH_NAMES[process.platform] ?? PATH_NAMES.linux) {
		for (const dir of dirs) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/** @returns {string} absolute path to a Chromium binary. Exits when none exists. */
export function resolveChrome() {
	for (const override of [process.env.CHROME_PATH, process.env.CHROME_BIN]) {
		if (override && existsSync(override)) return override;
	}
	for (const candidate of CANDIDATES[process.platform] ?? CANDIDATES.linux) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	const onPath = fromPath();
	if (onPath) return onPath;
	console.error(
		'No Chromium binary found. Set CHROME_PATH (or CHROME_BIN) to a Chrome/Chromium/Edge executable.\n'
		+ `Looked in: ${(CANDIDATES[process.platform] ?? CANDIDATES.linux).join(', ')}`
	);
	process.exit(2);
}
