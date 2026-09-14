import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { resolveChrome } from './chrome.mjs';

// Each run owns a fresh profile and random port; never attach to another run.
const profile = await mkdtemp(join(tmpdir(), 'quota-capsule-'));
const chrome = spawn(resolveChrome(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const output = new URL('../docs/verification/', import.meta.url);
await mkdir(output, { recursive: true });
const results = [], errors = [], pending = new Map();
let ws, seq = 0;
const check = (name, condition, data) => {
  results.push({ name, pass: !!condition, data });
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}`);
  assert.ok(condition, `${name}: ${JSON.stringify(data)}`);
};
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(msg.id);
    msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error(`Not ready: ${expression}`);
  };
  const mouse = (type, p) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const center = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const click = async selector => { const p = await center(selector); await mouse('mousePressed', p); await mouse('mouseReleased', p); await sleep(260); };
  const drag = async (dx, dy) => {
    const p = await center('#dsh-quota-capsule');
    await mouse('mousePressed', p);
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', { x: p.x + dx * i / 8, y: p.y + dy * i / 8 }); await sleep(25); }
    await mouse('mouseReleased', { x: p.x + dx, y: p.y + dy }); await sleep(260);
  };
  const key = async (key, code, n) => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: n, ...(type === 'keyDown' && (key === 'Enter' || key === ' ') ? { text: key === 'Enter' ? '\r' : ' ' } : {}) });
    await sleep(260);
  };
  const load = async (dark = false, query = '') => {
    await send('Page.navigate', { url: new URL(`../docs/demo${dark ? '-dark' : ''}.html${query}`, import.meta.url).href });
    await wait(`!!window.DSH_PLUGIN_INTEGRATION_V1?.get('quota') && document.querySelector('.dsh-capsule-item')?.textContent !== '…'`);
  };
  const state = () => evaluate(`(()=>{
    const p=document.getElementById('dsh-quota-panel'),c=document.getElementById('dsh-quota-capsule'),s=document.getElementById('dsh-quota-compact-row'),d=document.getElementById('dsh-quota-detail'),l=document.getElementById('dsh-quota-lock'),rf=document.getElementById('dsh-quota-refresh'),r=c.getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,right:r.right,small:getComputedStyle(s).display,detail:getComputedStyle(d).display,lock:getComputedStyle(l).display,refresh:getComputedStyle(rf).display,open:c.getAttribute('aria-expanded')==='true',locked:l.getAttribute('aria-pressed')==='true',values:Array.from(s.querySelectorAll('.dsh-capsule-item'),n=>n.textContent),snapshot:window.DSH_PLUGIN_INTEGRATION_V1.snapshotOf('quota')};
  })()`);
  const layout = async name => {
    const out = await evaluate(`(()=>{
      const c=document.getElementById('dsh-quota-capsule'),r=c.getBoundingClientRect(),open=c.getAttribute('aria-expanded')==='true',l=document.getElementById('dsh-quota-lock').getBoundingClientRect();
      const boxes=Array.from(c.querySelectorAll(open?'#dsh-quota-detail span:not(:has(*))':'.dsh-capsule-item')).filter(n=>n.textContent).map(n=>{const range=document.createRange();range.selectNodeContents(n);const b=range.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,text:n.textContent}});
      const overlap=(a,b)=>a.x<b.right-.5&&a.right>b.x+.5&&a.y<b.bottom-.5&&a.bottom>b.y+.5;
      return {capsule:r.toJSON(),lock:l.toJSON(),boxes,ok:boxes.every(b=>b.x>=r.x&&b.right<=r.right&&b.y>=r.y&&b.bottom<=r.bottom)&&!boxes.some((a,i)=>boxes.slice(i+1).some(b=>overlap(a,b)))&&(!open||!boxes.some(b=>overlap(b,l)))};
    })()`);
    check(name, out.ok, out);
  };
  const shot = async name => {
    const r = await state();
    const image = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x - 5), y: r.y - 5, width: r.w + 10, height: r.h + 10, scale: 2 } });
    await writeFile(new URL(name, output), Buffer.from(image.data, 'base64'));
    const full = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(new URL(name.replace('.png', '-page.png'), output), Buffer.from(full.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await load();
  // The widget picks its language from navigator.language (overridable through
  // localStorage), so a developer machine reporting zh-CN and a CI runner
  // reporting en-US would otherwise assert different strings. Pin the language
  // the demo pages themselves are written in before asserting any copy.
  await evaluate(`localStorage.setItem('dsh.quota.lang','zh')`);
  await load();
  const base = await state();
  check('short capsule, readable one row, detail/lock hidden', base.w <= 128 && base.h === 34 && base.w/base.h <= 4 && base.small === 'grid' && base.detail === 'none' && base.lock === 'none', base);
  await layout('small text contained, no overlapping values');
  await shot('light-small.png');
  await click('#dsh-quota-capsule');
  const open = await state();
  check('narrow expanded details with refresh/lock controls', open.w === 168 && open.h > 200 && open.small === 'none' && open.detail === 'grid' && open.lock !== 'none' && open.refresh !== 'none', open);
  check('same left/bottom anchor', open.x === base.x && open.bottom === base.bottom);
  await layout('provider details and lock do not overlap');
  check('OpenCode and CommandCode display individual usage windows', await evaluate(`document.querySelectorAll('.quota-window').length>=5&&document.getElementById('dsh-quota-detail').textContent.includes('本期费用')`));
  check('manual refresh control preserves expanded state', await evaluate(`document.querySelector('#dsh-quota-refresh').getAttribute('aria-label')==='刷新额度'`));
  await shot('light-expanded.png');
  check('separate native refresh/lock buttons, no nested controls', await evaluate(`document.querySelectorAll('#dsh-quota-panel button').length===3&&!document.querySelector('#dsh-quota-capsule button,#dsh-quota-capsule [role=button]')`));
  await click('#dsh-quota-capsule');
  for (let i = 0; i < 3; i++) { await click('#dsh-quota-capsule'); await click('#dsh-quota-capsule'); }
  check('repeat click returns to same one-line capsule', !(await state()).open && (await state()).bottom === base.bottom);
  await drag(160, -100);
  const moved = await state();
  check('unlocked actual pointer drag moves in both axes without opening', moved.x === base.x + 160 && moved.y === base.y - 100 && !moved.open, moved);
  await click('#dsh-quota-capsule');
  const before = await state();
  await click('#dsh-quota-lock');
  check('actual lock click keeps detail open', (await state()).locked && (await state()).open);
  await drag(120, -60);
  const locked = await state();
  check('locked pointer drag changes neither coordinate nor open state', locked.x === before.x && locked.y === before.y && locked.open, locked);
  await shot('light-locked.png');
  await load();
  check('reload restores lock/position', (await state()).locked && (await state()).x === moved.x && (await state()).y === moved.y);
  await click('#dsh-quota-capsule'); await click('#dsh-quota-lock');
  const un = await state();
  await drag(100, -50);
  check('unlock restores actual drag in expanded state', !(await state()).locked && (await state()).x === un.x + 100 && (await state()).y === un.y - 50 && (await state()).open);
  await key('Escape', 'Escape', 27);
  check('Escape collapses and returns focus', !(await state()).open && await evaluate(`document.activeElement.id==='dsh-quota-capsule'`));
  await key('Enter', 'Enter', 13); await key('Tab', 'Tab', 9);
  check('Enter opens, Tab reaches lock', (await state()).open && await evaluate(`document.activeElement.id==='dsh-quota-lock'`), { state: await state(), active: await evaluate(`document.activeElement.outerHTML.slice(0,250)`) });
  await key(' ', 'Space', 32);
  check('Space locks without collapse', (await state()).locked && (await state()).open);
  await key('Escape', 'Escape', 27); await key(' ', 'Space', 32);
  check('Space on main button expands', (await state()).open);

  const refresh = async () => {
    await evaluate(`window.DSH_PLUGIN_INTEGRATION_V1.callAction('quota','refresh')`);
    await sleep(100);
  };
  await evaluate(`window.__savedFetch=window.fetch;window.fetch=async url=>String(url).endsWith('/deepseek')?{text:async()=>JSON.stringify({ok:true,data:{balance_infos:[{currency:'CNY',total_balance:'5'}]}})}:window.__savedFetch(url)`);
  await refresh();
  check('healthy→critical shows new ¥5, not stale ¥58', (await state()).values[0] === '¥5' && (await state()).snapshot.providers[0].status === 'error');
  await evaluate(`window.fetch=async url=>String(url).endsWith('/deepseek')?{text:async()=>JSON.stringify({ok:false,error:{code:'network'}})}:window.__savedFetch(url)`);
  await refresh();
  check('failed refresh retains latest ¥5 as stale', (await state()).values[0] === '¥5' && (await state()).snapshot.providers[0].status === 'stale');
  await evaluate(`window.fetch=window.__savedFetch`); await refresh();
  check('recovery returns fresh data', (await state()).values[0] === '¥58' && (await state()).snapshot.providers[0].status === 'ok');
  await load(false, '?fail=command');
  check('first-load failure shows unknown —, never 0', (await state()).values[2] === '—' && (await state()).snapshot.providers[2].status === 'unknown');
  for (const dark of [false, true]) {
    await load(dark);
    if (dark) await shot('dark-small.png');
    await click('#dsh-quota-capsule');
    if (dark) await shot('dark-expanded.png');
    for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
      await evaluate(`document.body.style.zoom='${zoom}';window.dispatchEvent(new Event('resize'))`);
      await sleep(260);
      await layout(`${dark ? 'dark' : 'light'} text at ${zoom * 100}% CSS zoom`);
    }
  }
  await load();
  await evaluate(`localStorage.removeItem('dsh.quota.pos');localStorage.setItem('dsh.quota.locked','0')`); await load();
  await evaluate(`const slot=document.createElement('div');slot.id='test-slot';slot.style.cssText='position:fixed;left:30px;bottom:100px;width:216px';document.body.appendChild(slot);window.DSH_PLUGIN_INTEGRATION_V1.mountCompact('quota',slot)`);
  check('optional host mounts complete shell', await evaluate(`!!document.querySelector('#test-slot>#dsh-quota-panel')`));
  await click('#dsh-quota-capsule'); await layout('host-mounted retains styling');
  await drag(120, -40);
  check('unlocked host-mounted capsule can detach and drag', await evaluate(`document.getElementById('dsh-quota-panel').parentElement===document.body`));
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const small = await state();
  check('narrow viewport clamps position', small.x >= 0 && small.right <= 320 && small.y >= 0 && small.bottom <= 480, small);
  await layout('narrow viewport text layout');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('reduced motion respected', await evaluate(`getComputedStyle(document.getElementById('dsh-quota-capsule')).transitionDuration==='0s'`));
  check('no runtime errors', errors.length === 0, errors);
  console.log(`${results.length} browser checks passed`);
} finally {
  await writeFile(new URL('browser-results.json', output), JSON.stringify(results, null, 2));
  for (const p of pending.values()) clearTimeout(p.timer);
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ id: 2147483647, method: 'Browser.close' })); ws.close(); }
  await sleep(200);
  if (chrome.exitCode === null) chrome.kill();
}
