#!/usr/bin/env node
// reelly titles: renders every title in the storyboard to transparent 1920x1080
// PNGs with Playwright, so real web fonts (Google Fonts or local) are used.
//
//   node titles.mjs <reelDir>
//
// Writes titles/<id>[-k].png and titles/titles.json. A title with reveal
// "words" or "lines" gets one PNG per stage; compose switches stages on beats.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadStoryboard } from './lib/storyboard.mjs';

import { launchChromium } from './lib/browser.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function css(sb) {
  const t = { background: '#07080d', text: '#f4f4ff', accent: '#8f82ff', ...(sb.theme || {}) };
  const fam = sb.font?.family || 'Inter Tight';
  return `
  html,body{margin:0;width:1920px;height:1080px;background:transparent;overflow:hidden}
  body{font-family:"${fam}",Inter,"Helvetica Neue",Arial,sans-serif;color:${t.text};-webkit-font-smoothing:antialiased}
  .h{opacity:0!important}
  .stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center}
  .opener{font-size:104px;font-weight:300;letter-spacing:-.035em;line-height:1.05;max-width:1500px}
  .opener b{font-weight:800}
  .word{font-size:168px;font-weight:800;letter-spacing:-.05em;line-height:.95;max-width:1600px}
  .center{font-size:88px;font-weight:600;letter-spacing:-.03em;max-width:1500px;line-height:1.08}
  .lower{position:absolute;left:0;right:0;bottom:0;height:420px;
    background:linear-gradient(0deg,rgba(0,0,0,.72) 0%,rgba(0,0,0,.45) 45%,rgba(0,0,0,0) 100%)}
  .lower .txt{position:absolute;left:120px;bottom:118px;font-size:78px;font-weight:800;letter-spacing:-.035em;line-height:1;
    text-shadow:0 4px 30px rgba(0,0,0,.5)}
  .lower .bar{position:absolute;left:120px;bottom:92px;width:96px;height:6px;border-radius:3px;background:${t.accent}}
  .end{flex-direction:column;gap:0}
  .end .name{font-size:168px;font-weight:800;letter-spacing:-.055em;line-height:1}
  .end .tag{font-size:50px;font-weight:300;letter-spacing:-.02em;margin-top:26px;opacity:.92}
  .end .url{font-size:32px;font-weight:600;letter-spacing:.06em;margin-top:56px;color:${t.accent};text-transform:lowercase}
  .end .rule{width:120px;height:4px;border-radius:2px;background:${t.accent};margin-top:46px}
  `;
}

function stagesFor(sb, t) {
  const style = t.style || 'center';
  if (style === 'endcard') {
    const p = sb.product || {};
    const parts = [
      `<div class="name w">${esc(t.name ?? p.name ?? '')}</div>`,
      `<div class="tag w">${esc(t.tagline ?? p.tagline ?? '')}</div>`,
      `<div class="rule w"></div><div class="url w">${esc(t.url ?? p.url ?? '')}</div>`,
    ];
    const reveal = t.reveal ?? 'lines';
    const n = reveal === 'lines' ? 3 : 1;
    return Array.from({ length: n }, (_, k) => {
      const vis = reveal === 'lines' ? k + 1 : 3;
      const html = parts.map((p, i) => (i < vis ? p : p.replaceAll('class="', 'class="h '))).join('');
      return `<div class="stage end">${html}</div>`;
    });
  }
  const words = String(t.text || '').split(/\s+/).filter(Boolean);
  // *word* marks emphasis in openers.
  const word = (w, hidden) => `<span class="w${hidden ? ' h' : ''}">${esc(w).replace(/\*(.+?)\*/g, '<b>$1</b>')}</span>`;
  const n = t.reveal === 'words' ? words.length : 1;
  return Array.from({ length: n }, (_, k) => {
    const vis = t.reveal === 'words' ? k + 1 : words.length;
    const inner = words.map((w, i) => word(w, i >= vis)).join(' ');
    if (style === 'lower') return `<div class="lower"><div class="txt">${inner}</div><div class="bar"></div></div>`;
    return `<div class="stage"><div class="${esc(style)}">${inner}</div></div>`;
  });
}

async function main() {
  const reelDir = path.resolve(process.argv[2] || '.');
  const sb = loadStoryboard(reelDir);
  const out = path.join(reelDir, 'titles');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const jobs = [];
  for (const it of sb.timeline) {
    if (it.type === 'title') jobs.push({ key: it.id, item: it.id, at: 0, beats: null, t: it });
    for (const [k, t] of (it.titles || []).entries()) jobs.push({ key: `${it.id}-t${k}`, item: it.id, at: t.at ?? 0, beats: t.beats ?? 4, t });
  }
  for (const j of jobs) {
    const words = String(j.t.text || '').split(/\s+/).filter(Boolean).length;
    if (words > 7) console.warn(`warning: title "${j.key}" has ${words} words; keep titles short.`);
  }

  const fam = sb.font?.family || 'Inter Tight';
  const weights = (sb.font?.weights || [300, 600, 800]).join(';');
  const fontLink = sb.font?.url || `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@${weights}&display=block`;

  const browser = await launchChromium(chromium, { args: ['--font-render-hinting=none'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const index = [];
  let fontOk = null;
  for (const j of jobs) {
    const stages = stagesFor(sb, j.t);
    const files = [];
    for (const [k, html] of stages.entries()) {
      await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${fontLink}"><style>${css(sb)}</style></head><body>${html}</body></html>`, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      if (fontOk === null) {
        fontOk = await page.evaluate(f => document.fonts.check(`800 40px "${f}"`) && [...document.fonts].some(ff => ff.family.replace(/"/g, '') === f && ff.status === 'loaded'), fam);
        if (!fontOk) console.warn(`warning: font "${fam}" did not load; titles fall back to Inter/system fonts.`);
      }
      const file = `${j.key}${stages.length > 1 ? `-${k}` : ''}.png`;
      await page.screenshot({ path: path.join(out, file), omitBackground: true });
      files.push(file);
    }
    index.push({ key: j.key, item: j.item, style: j.t.style || 'center', at: j.at, beats: j.beats, reveal: j.t.reveal || (j.t.style === 'endcard' ? 'lines' : null), files });
    console.log(`  title ${j.key}: ${files.length} png`);
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'titles.json'), JSON.stringify({ font: fam, fontLoaded: !!fontOk, titles: index }, null, 2));
  console.log(`Wrote ${index.length} titles to ${out}`);
}

main().catch(e => { console.error(`titles failed: ${e.stack || e.message}`); process.exit(1); });
