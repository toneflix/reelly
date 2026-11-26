#!/usr/bin/env node
// reelly capture: drives a product in headless Chromium frame by frame.
//
//   node capture.mjs <reelDir> [--only id,id] [--quality 92]
//   node capture.mjs study <url|path> <outDir> [--max 12]
//
// Time is deterministic: the page clock is installed before load, paused after
// load and only ever advanced by exactly one frame. CSS animations, transitions
// and <video> are paused and stepped from the same clock.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadStoryboard, layout, framesPerBeat, beatToFrame, MAX_ZOOM } from './lib/storyboard.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0); // fixed wall clock every capture starts from
const pageErrors = []; // JavaScript errors the product threw while being captured

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.md': 'text/markdown' };

async function serve(target) {
  if (/^https?:\/\//.test(target)) return { base: target.replace(/\/$/, ''), close: () => {} };
  let root = path.resolve(target);
  let index = 'index.html';
  if (fs.existsSync(root) && fs.statSync(root).isFile()) { index = path.basename(root); root = path.dirname(root); }
  if (!fs.existsSync(root)) throw new Error(`Cannot find ${target}`);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += index;
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close(), root };
}

function resolveTarget(sb, reelDir) {
  const t = sb.url;
  if (!t) throw new Error('storyboard.url is required');
  if (/^https?:\/\//.test(t)) return t;
  for (const cand of [path.resolve(t), path.resolve(reelDir, t)]) if (fs.existsSync(cand)) return cand;
  throw new Error(`storyboard.url "${t}" is neither a URL nor an existing path`);
}

const joinUrl = (base, p) => (!p ? base + '/' : /^https?:/.test(p) ? p : base + (p.startsWith('/') ? p : '/' + p));

function initScript({ hide }) {
  const css = `${hide.length ? hide.join(',') + '{display:none!important}' : ''}
    ::-webkit-scrollbar{display:none!important}
    #__reelly_cursor{position:fixed;left:0;top:0;width:34px;height:34px;z-index:2147483647;pointer-events:none;display:none;
      transform:translate(-100px,-100px);filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))}
    #__reelly_cursor svg{width:100%;height:100%;transform-origin:4px 3px;transition:transform .12s ease-out}
    #__reelly_cursor.down svg{transform:scale(.86)}
    .__reelly_ripple{position:fixed;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;z-index:2147483646;pointer-events:none;
      border:3px solid rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.15);animation:__reelly_rip .5s ease-out forwards}
    @keyframes __reelly_rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.25);opacity:0}}`;
  const arrow = `<svg viewBox="0 0 24 24"><path d="M4 2.5 L4 19.5 L8.6 15.4 L11.6 22 L14.6 20.7 L11.7 14.2 L18 14.2 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  return `(() => {
    const css = ${JSON.stringify(css)};
    const arrow = ${JSON.stringify(arrow)};
    let cursor, shown = false;
    function mount() {
      if (document.getElementById('__reelly_style')) return;
      const st = document.createElement('style'); st.id = '__reelly_style'; st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
      cursor = document.createElement('div'); cursor.id = '__reelly_cursor'; cursor.innerHTML = arrow;
      document.documentElement.appendChild(cursor);
      cursor.style.display = shown ? 'block' : 'none';
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
    addEventListener('mousemove', e => { if (cursor) cursor.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 3) + 'px)'; }, true);
    addEventListener('mousedown', e => {
      if (!cursor || !shown) return;
      cursor.classList.add('down');
      const r = document.createElement('div'); r.className = '__reelly_ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r);
      r.addEventListener('animationend', () => r.remove());
    }, true);
    addEventListener('mouseup', () => cursor && cursor.classList.remove('down'), true);
    window.__reelly = {
      showCursor(on) { shown = on; mount(); cursor.style.display = on ? 'block' : 'none'; },
      // Step every animation from the (fake) clock. Called once per captured frame.
      tick() {
        const now = performance.now();
        for (const a of document.getAnimations()) {
          let r = a.__reelly;
          if (!r) { r = a.__reelly = { born: now }; try { a.pause(); } catch (e) {} }
          const t = now - r.born;
          const end = a.effect && a.effect.getComputedTiming().endTime;
          try { if (Number.isFinite(end) && t >= end) a.finish(); else a.currentTime = t; } catch (e) {}
        }
        for (const v of document.querySelectorAll('video')) {
          if (!v.__reelly) { v.__reelly = { born: now }; v.pause(); }
          if (v.duration) v.currentTime = ((now - v.__reelly.born) / 1000) % v.duration;
        }
      },
      async settled() {
        await document.fonts.ready;
        const imgs = [...document.images].filter(i => !i.complete || (i.naturalWidth && !i.__dec));
        await Promise.all(imgs.map(i => (i.complete ? Promise.resolve() : new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))
          .then(() => i.decode && i.decode().catch(() => {})).then(() => { i.__dec = true; })));
      },
      textBoxes(limit) {
        const out = [];
        const w = innerWidth, h = innerHeight;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode()) && out.length < limit) {
          if (!n.textContent.trim()) continue;
          const el = n.parentElement; if (!el || el.closest('#__reelly_cursor')) continue;
          const cs = getComputedStyle(el);
          if (el.checkVisibility ? !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : (cs.visibility === 'hidden' || +cs.opacity === 0)) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > w || r.top > h) continue;
          out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), parseFloat(cs.fontSize), n.textContent.trim().slice(0, 40)]);
        }
        return out;
      }
    };
  })();`;
}

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = t => 1 - Math.pow(1 - t, 3);
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** A hand-like path: eased along a slight arc, with an overshoot-free settle. */
function handPath(points, arc = 0.06) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    segs.push({ x0, y0, x1, y1, len, from: total });
    total += len;
  }
  return t => {
    const e = easeInOut(Math.min(1, Math.max(0, t)));
    if (!total) return points[points.length - 1];
    const d = e * total;
    const s = segs.find(s => d <= s.from + s.len + 1e-9) || segs[segs.length - 1];
    const u = s.len ? (d - s.from) / s.len : 1;
    const nx = -(s.y1 - s.y0) / (s.len || 1), ny = (s.x1 - s.x0) / (s.len || 1);
    const bow = Math.sin(Math.PI * u) * arc * s.len;
    return [s.x0 + (s.x1 - s.x0) * u + nx * bow, s.y0 + (s.y1 - s.y0) * u + ny * bow];
  };
}

async function point(page, target, offset) {
  if (Array.isArray(target)) return target;
  const sel = typeof target === 'object' ? target.selector : target;
  const off = (typeof target === 'object' && target.offset) || offset || [0, 0];
  const box = await page.locator(sel).first().boundingBox({ timeout: 5000 }).catch(() => null);
  if (!box) throw new Error(`Target "${sel}" was not found or is not visible`);
  return [box.x + box.width / 2 + off[0], box.y + box.height / 2 + off[1]];
}

const POINTER = new Set(['click', 'hover', 'move', 'drag', 'dblclick']);

function planActions(sb, actions) {
  const fpb = framesPerBeat(sb);
  return (actions || []).map((a, i) => {
    const at = beatToFrame(sb, a.at ?? 0);
    const span = Math.max(1, Math.round((a.beats ?? defaultBeats(a)) * fpb));
    let s, e;
    if (['click', 'hover', 'move', 'dblclick'].includes(a.do)) { s = at - span; e = at; }
    else if (a.do === 'drag') { s = at - Math.round((a.approach ?? 1) * fpb); e = at + span; }
    else { s = at; e = at + span; }
    return { ...a, i, at, span, s: Math.max(0, s), e };
  });
}
function defaultBeats(a) {
  return { click: 1, hover: 1, move: 1, dblclick: 1, drag: 3.5, type: 4, scroll: 3, press: 0, call: 0, wait: 0 }[a.do] ?? 1;
}

async function runPrepare(page, sb, steps, setupMod, ctx) {
  for (const a of steps || []) {
    if (a.do === 'click' || a.do === 'dblclick') { const [x, y] = await point(page, a.target, a.offset); await page.mouse.click(x, y, { clickCount: a.do === 'dblclick' ? 2 : 1 }); }
    else if (a.do === 'hover' || a.do === 'move') { const [x, y] = await point(page, a.target, a.offset); await page.mouse.move(x, y); }
    else if (a.do === 'type') { if (a.target) await page.locator(a.target).first().focus(); await page.keyboard.type(a.text); }
    else if (a.do === 'press') await page.keyboard.press(a.key);
    else if (a.do === 'scroll') await scrollBy(page, a, a.by ?? (await scrollDelta(page, a)));
    else if (a.do === 'call') await callHook(setupMod, a, page, ctx);
    else if (a.do === 'wait') {}
    else throw new Error(`Unknown prepare action "${a.do}"`);
    await advance(page, Math.round((a.ms ?? 120)));
  }
}

async function callHook(setupMod, a, page, ctx) {
  const fn = setupMod?.actions?.[a.fn];
  if (!fn) throw new Error(`setup.js has no actions.${a.fn}`);
  await fn(page, { ...ctx, args: a.args });
}

async function scrollDelta(page, a) {
  if (a.to == null) return 0;
  if (typeof a.to === 'number') return a.to - (await page.evaluate(sel => (sel ? document.querySelector(sel) : document.scrollingElement).scrollTop, a.in || null));
  const box = await page.locator(a.to).first().boundingBox();
  return box ? box.y - (a.margin ?? 160) : 0;
}
async function scrollBy(page, a, dy) {
  await page.evaluate(([sel, dy]) => { const el = sel ? document.querySelector(sel) : document.scrollingElement; el.scrollTop += dy; }, [a.in || null, dy]);
}

/** Advance the paused clock by ms, stepping animations at frame-sized intervals. */
async function advance(page, ms) {
  const step = 1000 / 30;
  for (let t = 0; t < ms; t += step) {
    await page.clock.runFor(Math.min(step, ms - t));
    await page.evaluate(() => window.__reelly.tick());
  }
}

async function openPage(browser, sb, base, item, setupMod, reelDir) {
  const context = await browser.newContext({
    viewport: { width: sb.viewport.width, height: sb.viewport.height },
    deviceScaleFactor: sb.viewport.deviceScaleFactor,
    colorScheme: sb.colorScheme || 'dark',
    reducedMotion: 'no-preference',
    locale: sb.locale || 'en-US',
    timezoneId: sb.timezone || 'UTC',
  });
  await context.addInitScript(initScript({ hide: sb.hide }));
  const page = await context.newPage();
  page.on('pageerror', e => { console.warn(`  [page error] ${e.message}`); pageErrors.push(`${item.id}: ${e.message}`); });
  await page.clock.install({ time: T0 });
  const ctx = { context, page, baseURL: base, item, reelDir };
  if (setupMod?.beforeEach) await setupMod.beforeEach(ctx);
  await page.goto(joinUrl(base, item.path), { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  if (setupMod?.afterLoad) await setupMod.afterLoad(ctx);
  // Pause the clock: from here on only runFor moves time.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
  await page.evaluate(() => window.__reelly.settled());
  await page.evaluate(() => window.__reelly.tick());
  return { context, page, ctx };
}

async function snap(page, file, quality) {
  await page.evaluate(() => window.__reelly.tick());
  await page.evaluate(() => window.__reelly.settled());
  const buf = await page.screenshot({ type: 'jpeg', quality, caret: 'initial', animations: 'allow' });
  fs.writeFileSync(file, buf);
}

async function captureShot(browser, sb, base, item, entry, outDir, setupMod, quality, reelDir) {
  const fpb = framesPerBeat(sb);
  const pad = Math.round(fpb); // tail frames used by dissolves
  const count = entry.frames + pad;
  const dir = path.join(outDir, 'frames', item.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const { context, page, ctx } = await openPage(browser, sb, base, item, setupMod, reelDir);
  await runPrepare(page, sb, item.prepare, setupMod, ctx);
  await advance(page, Math.round((item.settle ?? 1) * 1000));

  const plan = planActions(sb, item.actions);
  const usesPointer = plan.some(a => POINTER.has(a.do));
  let cur = item.cursor || [sb.viewport.width * 0.72, sb.viewport.height * 0.78];
  await page.mouse.move(cur[0], cur[1]);
  await page.evaluate(on => window.__reelly.showCursor(on), usesPointer && item.showCursor !== false);

  const rnd = mulberry32(item.seed ?? 7);
  const events = [];
  const cursorTrack = [];
  const state = new Map();
  const cam = (item.camera || [{ at: 0, zoom: 1 }]).map(k => ({ ...k, frame: beatToFrame(sb, k.at ?? 0) })).sort((a, b) => a.frame - b.frame);
  const camOut = [];
  let lastCenter = [sb.viewport.width / 2, sb.viewport.height / 2];
  const probeFrames = new Set([0, Math.floor(entry.frames / 2), Math.max(0, entry.frames - 1)]);
  const text = [];
  const dt = f => Math.round(((f + 1) * 1000) / sb.fps) - Math.round((f * 1000) / sb.fps);

  for (let f = 0; f < count; f++) {
    for (const a of plan) {
      if (f < a.s || f > a.e) continue;
      const st = state.get(a.i) || {};
      if (!state.has(a.i)) state.set(a.i, st);
      if (['click', 'hover', 'move', 'dblclick'].includes(a.do)) {
        if (f === a.s) st.path = handPath([cur, await point(page, a.target, a.offset)], a.arc ?? 0.06);
        const p = st.path((f - a.s) / Math.max(1, a.e - a.s));
        await page.mouse.move(p[0], p[1]); cur = p;
        if (f === a.e && a.do !== 'hover' && a.do !== 'move') {
          await page.mouse.down(); st.upAt = f + 3;
          events.push({ frame: f, kind: 'click', x: p[0], y: p[1] });
          if (a.do === 'dblclick') st.dbl = true;
        }
        if (f === a.e && (a.do === 'hover' || a.do === 'move')) events.push({ frame: f, kind: 'hover', x: p[0], y: p[1] });
      } else if (a.do === 'drag') {
        if (f === a.s) {
          st.from = await point(page, a.from, a.fromOffset);
          st.approach = handPath([cur, st.from], 0.05);
        }
        if (f < a.at) { const p = st.approach((f - a.s) / Math.max(1, a.at - a.s)); await page.mouse.move(p[0], p[1]); cur = p; }
        if (f === a.at) {
          await page.mouse.move(st.from[0], st.from[1]); cur = st.from;
          await page.mouse.down();
          events.push({ frame: f, kind: 'press', x: cur[0], y: cur[1] });
          const to = await point(page, a.to, a.toOffset);
          st.path = handPath([st.from, ...(a.via || []), to], a.arc ?? 0.04);
        }
        if (f > a.at) {
          const p = st.path((f - a.at) / Math.max(1, a.e - a.at));
          await page.mouse.move(p[0], p[1], { steps: 2 }); cur = p;
          if (f === a.e) { await page.mouse.up(); events.push({ frame: f, kind: 'release', x: p[0], y: p[1] }); }
        }
      } else if (a.do === 'type') {
        if (f === a.s) {
          if (a.target) await page.locator(a.target).first().focus();
          const n = [...a.text].length;
          // Spread keys over the span with a little human jitter, never two on one frame.
          st.keys = [...a.text].map((ch, k) => ({ ch, frame: a.s + Math.round(((k + 0.15 + (rnd() - 0.5) * 0.5) / n) * a.span) }));
          for (let k = 1; k < st.keys.length; k++) st.keys[k].frame = Math.max(st.keys[k].frame, st.keys[k - 1].frame + 1);
          events.push({ frame: f, kind: 'type-start', chars: n, frames: a.span });
        }
        for (const k of st.keys) if (k.frame === f) { await page.keyboard.type(k.ch); events.push({ frame: f, kind: 'key' }); }
        if (f === a.e) for (const k of st.keys) if (k.frame > f) await page.keyboard.type(k.ch);
      } else if (a.do === 'scroll') {
        if (f === a.s) { st.total = a.by ?? (await scrollDelta(page, a)); st.done = 0; events.push({ frame: f, kind: 'scroll', by: st.total, frames: a.span }); }
        const target = st.total * easeInOut((f - a.s) / Math.max(1, a.e - a.s));
        await scrollBy(page, a, target - st.done); st.done = target;
      } else if (a.do === 'press') {
        if (f === a.s) { await page.keyboard.press(a.key); events.push({ frame: f, kind: 'key' }); }
      } else if (a.do === 'call') {
        if (f === a.s) { await callHook(setupMod, a, page, ctx); events.push({ frame: f, kind: 'call', fn: a.fn }); }
      } else if (a.do !== 'wait') throw new Error(`Unknown action "${a.do}" in shot "${item.id}"`);
    }
    for (const [i, st] of state) {
      if (st.upAt === f) {
        await page.mouse.up();
        if (st.dbl) { await page.mouse.down(); await page.mouse.up(); }
        st.upAt = null;
      }
    }

    // Camera keyframes resolve on the frame they apply to.
    for (const k of cam) if (k.frame === f || (f === count - 1 && k.frame >= count)) {
      let center = k.center;
      if (center === 'cursor') center = 'cursor';
      else if (center == null) center = lastCenter;
      else center = await point(page, center, k.offset).catch(e => { console.warn(`  camera: ${e.message}`); return lastCenter; });
      if (center !== 'cursor') lastCenter = center;
      let zoom = k.zoom ?? 1;
      if (zoom > MAX_ZOOM) { console.warn(`  camera zoom ${zoom} in "${item.id}" clamped to ${MAX_ZOOM}`); zoom = MAX_ZOOM; }
      camOut.push({ frame: k.frame, zoom: Math.max(1, zoom), center, ease: k.ease || 'inOut' });
    }

    cursorTrack.push([Math.round(cur[0]), Math.round(cur[1])]);
    await snap(page, path.join(dir, `${String(f).padStart(5, '0')}.jpg`), quality);
    if (probeFrames.has(f)) text.push({ frame: f, boxes: await page.evaluate(() => window.__reelly.textBoxes(500)) });
    await page.clock.runFor(dt(f));
    if (f % 30 === 0) process.stdout.write(`\r  ${item.id}: frame ${f + 1}/${count}   `);
  }
  process.stdout.write(`\r  ${item.id}: ${count} frames                 \n`);
  await context.close();
  return { dir: path.relative(outDir, dir), count, pad, events, cursor: cursorTrack, camera: camOut, text, cursorVisible: usesPointer };
}

async function captureMontage(browser, sb, base, item, entry, outDir, setupMod, quality, reelDir) {
  const dir = path.join(outDir, 'frames', item.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const slides = [];
  const n = entry.slides.length;
  const defs = item.slides || [];
  if (defs.length < n) console.warn(`  montage "${item.id}" defines ${defs.length} slides for ${n} slots; slides will repeat.`);
  let open = null;
  for (let k = 0; k < n; k++) {
    const s = defs[k % Math.max(1, defs.length)] || {};
    if (s.from) { slides.push({ k, from: s.from, at: s.at ?? 0, zoom: Math.min(MAX_ZOOM, s.zoom ?? 1), center: s.center ?? null, push: s.push ?? 0.04 }); continue; }
    const key = JSON.stringify([s.path, s.prepare]);
    if (!open || open.key !== key || s.fresh) {
      if (open) await open.context.close();
      const o = await openPage(browser, sb, base, { ...s, id: `${item.id}-${k}` }, setupMod, reelDir);
      await runPrepare(o.page, sb, s.prepare, setupMod, o.ctx);
      await advance(o.page, Math.round((s.settle ?? 1.2) * 1000));
      open = { ...o, key };
    }
    const page = open.page;
    if (s.scroll != null) {
      await page.evaluate(([sel, y]) => { const el = sel ? document.querySelector(sel) : document.scrollingElement; el.scrollTop = y; }, [s.in || null, s.scroll]);
      await advance(page, 100);
    }
    if (s.hover) { const [x, y] = await point(page, s.hover); await page.mouse.move(x, y); await advance(page, 400); }
    const file = path.join(dir, `${String(k).padStart(5, '0')}.jpg`);
    await snap(page, file, quality);
    let center = null;
    if (s.center) center = await point(page, s.center, s.offset).catch(() => null);
    let zoom = s.zoom ?? 1;
    if (zoom > MAX_ZOOM) zoom = MAX_ZOOM;
    const text = await page.evaluate(() => window.__reelly.textBoxes(500));
    slides.push({ k, file: path.relative(outDir, file), zoom, center, push: s.push ?? 0.04, text });
    process.stdout.write(`\r  ${item.id}: slide ${k + 1}/${n}   `);
  }
  if (open) await open.context.close();
  process.stdout.write(`\r  ${item.id}: ${n} slides             \n`);
  return { dir: path.relative(outDir, dir), slides };
}

async function study(target, outDir, max) {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve(/^https?:/.test(target) ? target : path.resolve(target));
  const browser = await chromium.launch({ args: ['--disable-smooth-scrolling', '--hide-scrollbars'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await context.newPage();
  const seen = new Set();
  const queue = [srv.base + '/'];
  const pages = [];
  const origin = new URL(srv.base).origin;
  while (queue.length && pages.length < max) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      const i = pages.length;
      const shot = path.join(outDir, `page-${String(i).padStart(2, '0')}.png`);
      await page.screenshot({ path: shot });
      const info = await page.evaluate(() => {
        const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        const sel = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].join('.') : '');
        return {
          title: document.title,
          headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(h => h.textContent.trim()).slice(0, 30),
          buttons: [...document.querySelectorAll('button,[role=button],a.btn,input[type=submit]')].filter(vis).map(b => ({ text: b.textContent.trim().slice(0, 60), selector: sel(b) })).slice(0, 40),
          inputs: [...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(vis).map(b => ({ selector: sel(b), placeholder: b.placeholder || '' })).slice(0, 20),
          links: [...document.querySelectorAll('a[href]')].map(a => a.href),
          text: document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 4000),
          scrollHeight: document.scrollingElement.scrollHeight,
        };
      });
      for (const l of info.links) { try { const u = new URL(l); if (u.origin === origin && !seen.has(u.href)) queue.push(u.href); } catch {} }
      delete info.links;
      pages.push({ url, screenshot: path.basename(shot), ...info });
      console.log(`  studied ${url}`);
    } catch (e) { console.warn(`  could not study ${url}: ${e.message}`); }
  }
  // README/docs next to a local product are part of the study.
  const docs = [];
  if (srv.root) for (const f of fs.readdirSync(srv.root)) if (/^(readme|docs?|changelog).*\.(md|txt)$/i.test(f)) docs.push({ file: f, text: fs.readFileSync(path.join(srv.root, f), 'utf8').slice(0, 8000) });
  fs.writeFileSync(path.join(outDir, 'study.json'), JSON.stringify({ base: srv.base, target, pages, docs }, null, 2));
  await browser.close();
  srv.close();
  console.log(`Wrote ${pages.length} pages to ${path.join(outDir, 'study.json')}`);
}

async function main() {
  if (argv[0] === 'study') {
    const max = +flag('max', 12);
    if (argv.length < 3) throw new Error('usage: capture.mjs study <url|path> <outDir> [--max 12]');
    return study(argv[1], argv[2], max);
  }
  const only = flag('only', null)?.split(',');
  const quality = +flag('quality', 92);
  const reelDir = path.resolve(argv[0] || '.');
  const sb = loadStoryboard(reelDir);
  const lay = layout(sb);
  lay.warnings.forEach(w => console.warn(`warning: ${w}`));

  let setupMod = null;
  if (sb.setup) {
    const sp = path.resolve(reelDir, sb.setup);
    setupMod = await import(pathToFileURL(sp).href);
    setupMod = setupMod.default && typeof setupMod.default === 'object' ? setupMod.default : setupMod;
  }

  const manifestFile = path.join(reelDir, 'manifest.json');
  const old = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const oldById = new Map((old?.items || []).map(i => [i.id, i]));

  const srv = await serve(resolveTarget(sb, reelDir));
  const browser = await chromium.launch({ args: ['--disable-smooth-scrolling', '--hide-scrollbars', '--font-render-hinting=none', '--force-color-profile=srgb'] });
  const t0 = Date.now();
  const items = [];
  try {
    for (const entry of lay.items) {
      const item = sb.timeline[entry.index];
      const prev = oldById.get(item.id);
      const wanted = !only || only.includes(item.id);
      let cap = {};
      if (item.type === 'shot' || item.type === 'montage') {
        if (!wanted) {
          cap = prev?.capture || {};
          if (!prev?.capture) console.warn(`warning: "${item.id}" has never been captured; run without --only first.`);
          else if (item.type === 'shot' && prev.capture.count < entry.frames + Math.round(lay.fpb)) console.warn(`warning: "${item.id}" got longer since it was captured; re-capture it.`);
          else if (item.type === 'montage' && prev.capture.slides?.length !== entry.slides.length) console.warn(`warning: "${item.id}" slide count changed; re-capture it.`);
        } else {
          console.log(`capturing ${item.type} "${item.id}" (${(entry.frames / sb.fps).toFixed(2)} s)`);
          cap = item.type === 'shot'
            ? await captureShot(browser, sb, srv.base, item, entry, reelDir, setupMod, quality, reelDir)
            : await captureMontage(browser, sb, srv.base, item, entry, reelDir, setupMod, quality, reelDir);
        }
      }
      items.push({ ...entry, capture: cap });
    }
  } finally {
    await browser.close();
    srv.close();
  }
  const manifest = {
    version: 1, fps: sb.fps, bpm: sb.bpm, beatsPerBar: sb.beatsPerBar, fpb: lay.fpb,
    width: sb.viewport.width, height: sb.viewport.height, dsf: sb.viewport.deviceScaleFactor,
    totalFrames: lay.totalFrames, seconds: lay.seconds, sections: lay.sections, cues: lay.cues, items, warnings: lay.warnings, pageErrors,
    capturedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  console.log(`manifest: ${items.length} items, ${lay.totalFrames} frames (${lay.seconds.toFixed(1)} s), captured in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch(e => { console.error(`capture failed: ${e.stack || e.message}`); process.exit(1); });
