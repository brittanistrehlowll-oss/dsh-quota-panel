// Build every picture the project page shows, from the *real* injected widget.
//
// Nothing here is hand-drawn: the capsule and panel captures come out of
// docs/demo.html + docs/demo-dark.html — the same pages `npm run demo` writes
// and `npm run verify` asserts — so the README can never drift away from the
// shipped panel script. Only the hero banner and the project mark are composed
// around those captures.
//
//   assets/banner.png        1280x640  hero lockup (also the repo social preview)
//   assets/logo.png           512x512  project mark
//   docs/images/capsule-{light,dark}.png   collapsed capsule on a card
//   docs/images/panel-{light,dark}.png     expanded panel on a card
//   docs/images/page-{light,dark}.png      the capsule in its default corner
//
// Run: npm run showcase   (needs Chrome/Chromium/Edge; CHROME_PATH overrides)
// Authoring tool, not a gate: the hero lockup uses the local UI font stack, so
// it is generated on a desktop (Windows/macOS/Linux) rather than inside the
// headless CI image.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { resolveChrome } from './chrome.mjs';

const IMAGES = new URL('../docs/images/', import.meta.url);
const ASSETS = new URL('../assets/', import.meta.url);
await mkdir(IMAGES, { recursive: true });
await mkdir(ASSETS, { recursive: true });

// Capture geometry. The export itself is rendered at CARD_SCALE, so these
// paddings are what decides how big the widget looks on the page card; the
// capture scales are chosen so the chip is shown at roughly 1:1 device pixels.
const CARD_SCALE = 2;
const CAPSULE = { padX: 16, padY: 14, scale: 4, chipWidth: 336 };   // 160x62 logical
const PANEL = { padX: 20, padY: 18, scale: 3, chipWidth: 260 };     // 208x420 logical

const rel = url => url.pathname.replace(/^.*\/(assets|docs)\//, '$1/');

const profile = await mkdtemp(join(tmpdir(), 'quota-showcase-'));
const scratch = await mkdtemp(join(tmpdir(), 'quota-canvas-'));
const chrome = spawn(resolveChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const pending = new Map();
let ws, seq = 0, canvas = 0;
try {
  let port;
  for (let i = 0; i < 80 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await sleep(100);
  }
  assert.ok(port, 'Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  ws.onmessage = e => {
    const msg = JSON.parse(e.data), item = pending.get(msg.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(msg.id);
    msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  };
  const wait = async (expression, tries = 120) => {
    for (let i = 0; i < tries; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error(`Not ready: ${expression}`);
  };
  const viewport = (width, height, scale) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  const capture = async (clip, scale) => {
    const shot = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale } } : { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  };
  const write = async (target, buffer) => {
    await writeFile(target, buffer);
    console.log(`${rel(target).padEnd(34)} ${buffer.length.toLocaleString().padStart(9)} bytes`);
  };
  const dataUri = buffer => `data:image/png;base64,${buffer.toString('base64')}`;

  // Render one standalone composition page and screenshot it.
  const render = async (width, height, body, scale = CARD_SCALE) => {
    const file = join(scratch, `canvas-${++canvas}.html`);
    await writeFile(file, `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
      img { display: block; }
      body { font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif; }
    </style></head><body>${body}</body></html>`, 'utf8');
    await viewport(width, height, scale);
    await send('Page.navigate', { url: `${pathToFileURL(file).href}?v=${canvas}` });
    await wait(`document.readyState === 'complete' && Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)`);
    await evaluate(`document.fonts.ready.then(() => true)`);
    await sleep(150);
    return capture(null, scale);
  };

  // ---------------------------------------------------------------- captures
  // Each capture is clipped with a little air around the widget, so the demo
  // page's own surface comes along and the slice is self-contained.
  const collect = async dark => {
    const page = new URL(`../docs/demo${dark ? '-dark' : ''}.html`, import.meta.url);
    const load = async query => {
      await send('Page.navigate', { url: page.href + query });
      await wait(`!!window.DSH_PLUGIN_INTEGRATION_V1?.get('quota') && document.querySelector('.dsh-capsule-item')?.textContent !== '…'`);
    };
    await load('');
    // Start from the real default corner: no remembered drag, never locked.
    await evaluate(`localStorage.removeItem('dsh.quota.pos');localStorage.setItem('dsh.quota.locked','0')`);
    await viewport(1280, 800, 1);
    await load('?shot=1');
    await sleep(200);
    const rect = selector => evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)}})()`);
    const clip = (box, padX, padY) => ({ x: box.x - padX, y: box.y - padY, width: box.width + padX * 2, height: box.height + padY * 2 });
    const collapsed = await rect('#dsh-quota-capsule');
    assert.ok(collapsed.x >= CAPSULE.padX && collapsed.y >= CAPSULE.padY, `capsule clipped by the viewport: ${JSON.stringify(collapsed)}`);
    const pageShot = await capture(null, 1);
    const capsule = await capture(clip(collapsed, CAPSULE.padX, CAPSULE.padY), CAPSULE.scale);
    await evaluate(`document.getElementById('dsh-quota-capsule').click()`);
    await wait(`document.getElementById('dsh-quota-capsule').getAttribute('aria-expanded') === 'true'`);
    await sleep(340);
    const expanded = await rect('#dsh-quota-capsule');
    assert.ok(expanded.x >= PANEL.padX && expanded.y >= PANEL.padY, `panel clipped by the viewport: ${JSON.stringify(expanded)}`);
    const panel = await capture(clip(expanded, PANEL.padX, PANEL.padY), PANEL.scale);
    return { page: pageShot, capsule, panel, collapsed, expanded };
  };

  const light = await collect(false);
  const dark = await collect(true);

  // ------------------------------------------------------------ gallery cards
  // A capture keeps the demo page's own surface, so each card adds air and
  // lifts the widget off the background — otherwise a white widget on a white
  // card would simply vanish on the light GitHub theme.
  const card = (width, height, theme, image, imageWidth) => {
    const isDark = theme === 'dark';
    return `<div style="width:${width}px;height:${height}px;background:${isDark ? '#101114' : '#eef0f4'};border:1px solid ${isDark ? 'rgba(255,255,255,.09)' : 'rgba(15,23,42,.08)'};border-radius:20px;display:flex;align-items:center;justify-content:center">
      <img src="${dataUri(image)}" style="width:${imageWidth}px;border-radius:14px;box-shadow:0 12px 32px rgba(9,16,32,${isDark ? '.55' : '.16'}),0 2px 6px rgba(9,16,32,${isDark ? '.4' : '.08'})">
    </div>`;
  };

  for (const theme of ['light', 'dark']) {
    const shot = theme === 'light' ? light : dark;
    const panelHeight = Math.round(PANEL.chipWidth * (shot.expanded.height + PANEL.padY * 2) / (shot.expanded.width + PANEL.padX * 2));
    await write(new URL(`capsule-${theme}.png`, IMAGES),
      await render(520, 180, card(520, 180, theme, shot.capsule, CAPSULE.chipWidth)));
    await write(new URL(`panel-${theme}.png`, IMAGES),
      await render(400, panelHeight + 96, card(400, panelHeight + 96, theme, shot.panel, PANEL.chipWidth)));
    await write(new URL(`page-${theme}.png`, IMAGES), shot.page);
  }

  // -------------------------------------------------------- mark and hero art
  // Three status dots inside a capsule: the whole product in one glyph.
  const mark = (size, radius) => {
    const dot = Math.round(size * 0.115), gap = Math.round(size * 0.1);
    return `<div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:linear-gradient(150deg,#1b2440 0%,#0b1020 100%);display:flex;align-items:center;justify-content:center;gap:${gap}px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.10)">
      ${['#22c55e', '#f59e0b', '#22c55e'].map(c => `<span style="width:${dot}px;height:${dot}px;border-radius:50%;background:${c};box-shadow:0 0 ${dot}px ${c}77"></span>`).join('')}
    </div>`;
  };

  await write(new URL('logo.png', ASSETS), await render(512, 512,
    `<div style="width:512px;height:512px;background:#0b1020;display:flex;align-items:center;justify-content:center">${mark(360, 96)}</div>`, 1));

  const chip = 'display:inline-flex;align-items:center;justify-content:center;height:38px;border-radius:19px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);color:#c3cddf;font-size:16px;letter-spacing:.2px';
  await write(new URL('banner.png', ASSETS), await render(1280, 640, `
    <div style="position:relative;width:1280px;height:640px;overflow:hidden;
      background:
        radial-gradient(880px 420px at 80% 16%, rgba(77,107,254,.32), rgba(77,107,254,0) 70%),
        radial-gradient(680px 380px at 10% 94%, rgba(65,118,230,.20), rgba(65,118,230,0) 72%),
        linear-gradient(140deg,#0d1424 0%,#0a0e1a 62%,#080b14 100%);
      display:flex;align-items:center">
      <div style="position:relative;width:640px;padding-left:80px">
        <div style="display:flex;align-items:center;gap:18px;margin-bottom:28px">
          ${mark(64, 18)}
          <div style="color:#7d8ca6;font-size:18px;letter-spacing:3.2px;text-transform:uppercase">DeepSeek Harness plugin</div>
        </div>
        <div style="font-size:70px;line-height:1.02;font-weight:700;color:#fff;letter-spacing:-1.5px">dsh-quota-panel</div>
        <div style="margin-top:20px;font-size:24px;line-height:1.45;color:#a8b6d1;max-width:540px">Provider quota and balance, one glance away — in the corner of the page.</div>
        <div style="margin-top:32px;display:grid;grid-template-columns:236px 236px;gap:12px;justify-content:start">
          <span style="${chip}">Zero dependency</span>
          <span style="${chip}">Keys stay host-side</span>
          <span style="${chip}">Web + Desktop</span>
          <span style="${chip}">Light / dark</span>
        </div>
      </div>
      <div style="position:absolute;right:78px;top:86px;display:flex;flex-direction:column;align-items:center;gap:26px">
        <img src="${dataUri(light.capsule)}" style="width:176px;border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.5)">
        <img src="${dataUri(light.panel)}" style="width:192px;border-radius:16px;box-shadow:0 26px 64px rgba(0,0,0,.55)">
      </div>
      <div style="position:absolute;left:80px;bottom:54px;color:#5c6980;font-size:17px;letter-spacing:.4px">github.com/brittanistrehlowll-oss/dsh-quota-panel</div>
    </div>`, 1));

  console.log('\nshowcase written');
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ id: 2147483647, method: 'Browser.close' })); ws.close(); }
  await sleep(200);
  if (chrome.exitCode === null) chrome.kill();
}
