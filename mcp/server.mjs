#!/usr/bin/env node
// reelly MCP server: exposes the reelly machinery (study, capture, titles,
// score, compose, review, contact sheets) as MCP tools, so any MCP host
// (Claude Code, Claude Desktop, Codex, Cursor, ChatGPT through a tunnel)
// can make a product reel. The host AI does the judgment; this server never
// calls an AI and needs no API key.
//
//   node mcp/server.mjs                         # stdio (local hosts)
//   node mcp/server.mjs --http 8765 [--host 127.0.0.1] [--token T] [--public-url https://x.example]
//
// Options (or env): --root / REELLY_ROOT     folder reels are made in (default: cwd)
//                   --token / REELLY_TOKEN   secret for HTTP mode (default: random, printed)
//                   --public-url / REELLY_PUBLIC_URL  base URL that download links use
//                   REELLY_PYTHON            python with numpy, scipy, Pillow (default python3)
//
// No dependencies beyond Node 22, so it starts before `npm install` has run.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const S = path.join(PLUGIN, 'scripts');
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const PY = process.env.REELLY_PYTHON || 'python3';

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = (name, env, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return process.env[env] ?? def;
};
const HTTP_PORT = opt('http', 'REELLY_HTTP_PORT', null);
const HTTP_HOST = opt('host', 'REELLY_HTTP_HOST', '127.0.0.1');
const ROOT = path.resolve(opt('root', 'REELLY_ROOT', process.cwd()));
const TOKEN = opt('token', 'REELLY_TOKEN', null) || (HTTP_PORT ? crypto.randomBytes(18).toString('base64url') : null);
const PUBLIC_URL = (opt('public-url', 'REELLY_PUBLIC_URL', '') || '').replace(/\/$/, '');
const REMOTE = !!HTTP_PORT; // remote callers stay inside ROOT

const log = (...a) => process.stderr.write(`[reelly-mcp] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- paths
function resolveIn(base, p, what = 'path') {
  if (!p || typeof p !== 'string') throw new UserError(`${what} is required`);
  const abs = path.resolve(base, p);
  if (REMOTE || base !== ROOT) {
    const rel = path.relative(base, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new UserError(`${what} must stay inside ${base}`);
  }
  return abs;
}
const reelDir = (reel, mustExist = true) => {
  const d = resolveIn(ROOT, reel, 'reel');
  if (mustExist && !fs.existsSync(path.join(d, 'storyboard.json'))) {
    throw new UserError(`${d} has no storyboard.json yet. Write one with reelly_write_file (see reelly_guide), or start from the demo with reelly_init.`);
  }
  return d;
};
const shown = p => (REMOTE ? path.relative(ROOT, p) || '.' : p);
const downloadUrl = p => (REMOTE && PUBLIC_URL ? `${PUBLIC_URL}/files/${TOKEN}/${path.relative(ROOT, p).split(path.sep).map(encodeURIComponent).join('/')}` : null);

class UserError extends Error {}

// ---------------------------------------------------------------- jobs
// Long steps (capture takes minutes) run as jobs, so they work under any
// host's tool timeout: a call waits up to wait_seconds, then hands back a job
// id that reelly_job waits on.
const jobs = new Map();
const busy = new Map(); // reel dir -> job id
let jobSeq = 0;

function startJob(label, reel, cmd, args, finish) {
  if (reel && busy.has(reel)) {
    const j = jobs.get(busy.get(reel));
    throw new UserError(`${j.label} is still running in this reel (job ${j.id}). Wait for it with reelly_job.`);
  }
  const id = `j${++jobSeq}`;
  const job = { id, label, reel, cmd: [cmd, ...args].join(' '), status: 'running', started: Date.now(), out: '', code: null, finish, done: null };
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const add = b => { job.out = (job.out + b.toString()).slice(-60000); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  job.done = new Promise(res => {
    child.on('error', e => { add(`\n${e.message}\n`); job.status = 'failed'; job.code = -1; res(); });
    child.on('close', code => { job.code = code; job.status = code === 0 ? 'done' : 'failed'; res(); });
  }).finally(() => { job.ended = Date.now(); if (reel) busy.delete(reel); });
  jobs.set(id, job);
  if (reel) busy.set(reel, id);
  return job;
}

async function waitJob(job, seconds) {
  const s = Math.max(0, Math.min(Number(seconds ?? 45), 600));
  await Promise.race([job.done, new Promise(r => setTimeout(r, s * 1000))]);
  return jobResult(job);
}

const tail = (s, n = 40) => s.replace(/\r/g, '\n').split('\n').filter(Boolean).slice(-n).join('\n');

async function jobResult(job) {
  const secs = (((job.ended || Date.now()) - job.started) / 1000).toFixed(0);
  if (job.status === 'running') {
    return [text(`${job.label}: still running after ${secs}s (job ${job.id}). Call reelly_job with job_id "${job.id}" to wait for it.\n\nLatest output:\n${tail(job.out, 12)}`)];
  }
  if (job.status === 'failed') {
    return { isError: true, content: [text(`${job.label} failed (exit ${job.code}) after ${secs}s.\n\n${tail(job.out, 60)}`)] };
  }
  const head = text(`${job.label}: done in ${secs}s.\n\n${tail(job.out, job.finish ? 4 : 25)}`);
  const more = job.finish ? await job.finish() : [];
  return [head, ...more];
}

// ---------------------------------------------------------------- content helpers
const text = t => ({ type: 'text', text: t });

function thumb(file, maxWidth = 960) {
  // JPEG thumbnail through Pillow (already a requirement), so contact sheets
  // and screenshots stay small enough for any host's context.
  return new Promise((resolve, reject) => {
    const code = 'import sys,io\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGB")\nw=int(sys.argv[2])\n' +
      'im.thumbnail((w,w*4))\nb=io.BytesIO()\nim.save(b,"JPEG",quality=82)\nsys.stdout.buffer.write(b.getvalue())';
    const p = spawn(PY, ['-c', code, file, String(maxWidth)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    p.stdout.on('data', c => chunks.push(c));
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err || `thumbnail failed for ${file}`))));
  });
}
async function image(file, maxWidth) {
  const data = await thumb(file, maxWidth);
  return { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' };
}

function outputs(dir) {
  const lines = [];
  for (const f of ['reel.mp4', 'reel.preview.mp4', 'poster.jpg', 'storyboard.json', 'score.wav']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const mb = (fs.statSync(p).size / 1e6).toFixed(1);
    const url = downloadUrl(p);
    lines.push(`- ${shown(p)} (${mb} MB)${url ? `  download: ${url}` : ''}`);
  }
  return lines.length ? `Files:\n${lines.join('\n')}` : '';
}

// ---------------------------------------------------------------- guide
function guide() {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'product-reel', 'SKILL.md'), 'utf8')
    .replace(/^---[\s\S]*?---\n/, '')
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN);
  return `# Using reelly through MCP

You are the director: you study the product, write the storyboard and the copy, and judge the result. The reelly tools are the crew: they film, score and cut, deterministically, and never call an AI.

The guide below was written for a shell. Wherever it shows a command, call the tool instead:

| Guide says | Call |
| --- | --- |
| \`$S/doctor\` | reelly_doctor |
| make \`reels/<name>/\` (or the \`demo\` steps) | reelly_init (demo: true copies the example storyboard and skips to capture) |
| \`node $S/capture.mjs study <url> reels/<name>/study\` | reelly_study (returns study.json and the screenshots) |
| write \`storyboard.json\` / \`setup.js\` | reelly_write_file (or your own file tools, if you have them) |
| \`node $S/capture.mjs reels/<name> [--only a,b]\` | reelly_capture (only: ["a","b"]) |
| \`node $S/titles.mjs\` | reelly_titles |
| \`python3 $S/music.py reels/<name>\` | reelly_score |
| \`python3 $S/music.py analyze song.mp3 reels/<name>\` | reelly_score with track |
| \`python3 $S/compose.py [--preview]\` | reelly_compose (preview: true) |
| \`python3 $S/review.py [--video ...]\` | reelly_review (returns report.md and the overview sheet) |
| look at \`review/<item>.jpg\`, \`study/page-NN.png\` | reelly_view |
| read \`report.md\`, \`score.json\`, \`manifest.json\` | reelly_read_file |

\`reel\` arguments are folders relative to ${REMOTE ? 'the server root' : ROOT} (for example \`reels/acme\`)${REMOTE ? '' : ', or absolute paths'}. Capture and compose take minutes: when a tool says a job is still running, call reelly_job with its id until it is done. Only one job runs per reel at a time.
${REMOTE ? `\nThis server runs remotely. The product URL must be reachable from the server's machine (localhost means the server's machine, not yours). Files you write and the finished reel live on that machine; tool results include download links when the server has a public URL.\n` : ''}
---

${skill}`;
}

// ---------------------------------------------------------------- tools
const reelArg = { type: 'string', description: 'Reel folder, e.g. "reels/acme" (relative to the server root)' };
const waitArg = { type: 'number', description: 'Seconds to wait for the step before returning a job id (default 45, max 600)' };

const TOOLS = [
  {
    name: 'reelly_guide', readOnly: true,
    description: 'Read this first. The full procedure for making a product reel: studying the product, the storyboard schema, pacing and copy rules, and the review checklist, mapped to these tools.',
    schema: {},
    run: async () => [text(guide())],
  },
  {
    name: 'reelly_doctor', readOnly: true,
    description: 'Check that Node 22, Python 3.11 with numpy/scipy/Pillow, ffmpeg and Playwright Chromium are installed on the machine this server runs on. Prints the fix for anything missing.',
    schema: {},
    run: async () => {
      const job = startJob('doctor', null, 'bash', [path.join(S, 'doctor')]);
      await job.done;
      const out = job.out.replace(/\x1b\[[0-9;]*m/g, '');
      return job.code === 0 ? [text(out)] : { isError: true, content: [text(out)] };
    },
  },
  {
    name: 'reelly_init',
    description: 'Create a reel folder. With demo: true, copy the Lumen example storyboard into it (pointed at the bundled demo product) so the whole pipeline can be tried without writing a storyboard.',
    schema: {
      name: { type: 'string', description: 'Short lowercase name; the folder is reels/<name>' },
      demo: { type: 'boolean', description: 'Start from the bundled Lumen demo storyboard' },
      folder: { type: 'string', description: 'Optional folder for the reel instead of reels/<name>, e.g. an absolute path inside the user\'s project' },
    },
    required: ['name'],
    run: async ({ name, demo, folder }) => {
      if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name || '')) throw new UserError('name must be lowercase letters, digits, "-", "_" or "."');
      const dir = resolveIn(ROOT, folder || path.join('reels', name), 'folder');
      fs.mkdirSync(dir, { recursive: true });
      let note = `Created ${shown(dir)}. Next: reelly_study, then write storyboard.json with reelly_write_file.`;
      if (demo) {
        const sb = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'examples', 'lumen', 'storyboard.json'), 'utf8'));
        sb.name = name;
        sb.url = path.join(PLUGIN, 'examples', 'demo');
        fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify(sb, null, 2) + '\n');
        note = `Created ${shown(dir)} with the Lumen demo storyboard. Next: reelly_capture, reelly_titles, reelly_score, reelly_compose, reelly_review.`;
      }
      return [text(note + `\n\nreel: "${REMOTE ? path.relative(ROOT, dir) : dir}"`)];
    },
  },
  {
    name: 'reelly_study',
    description: 'Crawl the product in headless Chromium: a screenshot per page plus headings, buttons with selectors, inputs, visible text and any README/docs next to a local product. Returns study.json and the screenshots to look at before writing the storyboard.',
    schema: {
      target: { type: 'string', description: 'http(s) URL (e.g. a dev server) or a local folder / .html file on the server machine' },
      reel: reelArg,
      max: { type: 'number', description: 'Most pages to visit (default 12)' },
      images: { type: 'boolean', description: 'Return the screenshots as images (default true)' },
      wait_seconds: waitArg,
    },
    required: ['target', 'reel'],
    run: async ({ target, reel, max = 12, images = true, wait_seconds }) => {
      const dir = resolveIn(ROOT, reel, 'reel');
      const out = path.join(dir, 'study');
      const tgt = /^https?:\/\//.test(target) ? target : resolveIn(ROOT, target, 'target');
      const job = startJob('study', dir, process.execPath, [path.join(S, 'capture.mjs'), 'study', tgt, out, '--max', String(Math.min(40, Number(max) || 12))], async () => {
        const study = JSON.parse(fs.readFileSync(path.join(out, 'study.json'), 'utf8'));
        const res = [text(`study.json (${shown(path.join(out, 'study.json'))}):\n${JSON.stringify(study, null, 1).slice(0, 60000)}`)];
        if (images) for (const p of study.pages.slice(0, 12)) res.push(text(`${p.screenshot}: ${p.url}`), await image(path.join(out, p.screenshot), 960));
        return res;
      });
      return waitJob(job, wait_seconds);
    },
  },
  {
    name: 'reelly_write_file',
    description: 'Write a text file inside a reel folder: storyboard.json, setup.js, or anything else the reel needs. JSON is checked before it is written.',
    schema: {
      reel: reelArg,
      path: { type: 'string', description: 'File path inside the reel folder, e.g. "storyboard.json"' },
      content: { type: 'string', description: 'The whole file' },
    },
    required: ['reel', 'path', 'content'],
    run: async ({ reel, path: p, content }) => {
      const dir = resolveIn(ROOT, reel, 'reel');
      const file = resolveIn(dir, p, 'path');
      if (file.endsWith('.json')) {
        try { JSON.parse(content); } catch (e) { throw new UserError(`${p} is not valid JSON: ${e.message}`); }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return [text(`Wrote ${shown(file)} (${Buffer.byteLength(content)} bytes).`)];
    },
  },
  {
    name: 'reelly_read_file', readOnly: true,
    description: 'Read a text file inside a reel folder (storyboard.json, review/report.md, score.json, manifest.json, study/study.json). Long files are cut at max_chars.',
    schema: { reel: reelArg, path: { type: 'string' }, max_chars: { type: 'number', description: 'Default 80000' } },
    required: ['reel', 'path'],
    run: async ({ reel, path: p, max_chars = 80000 }) => {
      const file = resolveIn(resolveIn(ROOT, reel, 'reel'), p, 'path');
      if (!fs.existsSync(file)) throw new UserError(`${shown(file)} does not exist`);
      const s = fs.readFileSync(file, 'utf8');
      return [text(s.length > max_chars ? s.slice(0, max_chars) + `\n... (cut at ${max_chars} of ${s.length} characters)` : s)];
    },
  },
  {
    name: 'reelly_list', readOnly: true,
    description: 'List the files in a reel folder or one of its subfolders (study, review, titles, frames).',
    schema: { reel: reelArg, path: { type: 'string', description: 'Subfolder, default the reel folder itself' } },
    required: ['reel'],
    run: async ({ reel, path: p = '.' }) => {
      const dir = resolveIn(resolveIn(ROOT, reel, 'reel'), p, 'path');
      if (!fs.existsSync(dir)) throw new UserError(`${shown(dir)} does not exist`);
      const rows = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
        if (e.isDirectory()) return `${e.name}/ (${fs.readdirSync(path.join(dir, e.name)).length} entries)`;
        return `${e.name} (${(fs.statSync(path.join(dir, e.name)).size / 1024).toFixed(0)} KB)`;
      });
      return [text(rows.join('\n') || '(empty)')];
    },
  },
  {
    name: 'reelly_view', readOnly: true,
    description: 'Look at an image in a reel folder: a contact sheet (review/<item>.jpg, review/overview.jpg), a study screenshot, a captured frame or the poster. Returned as a JPEG at most max_width wide.',
    schema: { reel: reelArg, path: { type: 'string', description: 'e.g. "review/overview.jpg"' }, max_width: { type: 'number', description: 'Default 1600' } },
    required: ['reel', 'path'],
    run: async ({ reel, path: p, max_width = 1600 }) => {
      const file = resolveIn(resolveIn(ROOT, reel, 'reel'), p, 'path');
      if (!fs.existsSync(file)) throw new UserError(`${shown(file)} does not exist`);
      return [await image(file, Math.max(200, Math.min(2400, Number(max_width) || 1600)))];
    },
  },
  {
    name: 'reelly_capture',
    description: 'Film every shot and montage in the storyboard frame by frame at 1920x1080 (deterministic clock, drawn cursor). About 3 minutes for a 60 s reel; pass only to re-capture just the shots you changed.',
    schema: { reel: reelArg, only: { type: 'array', items: { type: 'string' }, description: 'Item ids to re-capture' }, wait_seconds: waitArg },
    required: ['reel'],
    run: async ({ reel, only, wait_seconds }) => {
      const dir = reelDir(reel);
      const args = [path.join(S, 'capture.mjs'), dir];
      if (only?.length) args.push('--only', only.join(','));
      return waitJob(startJob('capture', dir, process.execPath, args), wait_seconds);
    },
  },
  {
    name: 'reelly_titles',
    description: 'Render every title in the storyboard to transparent PNGs with real web fonts. Run again whenever copy changes.',
    schema: { reel: reelArg, wait_seconds: waitArg },
    required: ['reel'],
    run: async ({ reel, wait_seconds }) => {
      const dir = reelDir(reel);
      return waitJob(startJob('titles', dir, process.execPath, [path.join(S, 'titles.mjs'), dir]), wait_seconds);
    },
  },
  {
    name: 'reelly_score',
    description: 'Synthesise the original score on the reel\'s beat grid (score.wav + score.json listing every placed sound). With track, instead detect a song\'s tempo and downbeat and snap the storyboard to it (then capture everything again).',
    schema: { reel: reelArg, track: { type: 'string', description: 'Optional audio file on the server machine to use instead of the synthesised score' }, wait_seconds: waitArg },
    required: ['reel'],
    run: async ({ reel, track, wait_seconds }) => {
      const dir = reelDir(reel);
      const args = track ? [path.join(S, 'music.py'), 'analyze', resolveIn(ROOT, track, 'track'), dir] : [path.join(S, 'music.py'), dir];
      return waitJob(startJob(track ? 'track analysis' : 'score', dir, PY, args), wait_seconds);
    },
  },
  {
    name: 'reelly_compose',
    description: 'Cut the captured frames, titles and score into the reel: camera moves, beat-synced cuts, titles, vignette, H.264 + AAC. preview: true renders a fast half-size reel.preview.mp4 for iterating.',
    schema: { reel: reelArg, preview: { type: 'boolean' }, wait_seconds: waitArg },
    required: ['reel'],
    run: async ({ reel, preview, wait_seconds }) => {
      const dir = reelDir(reel);
      const args = [path.join(S, 'compose.py'), dir];
      if (preview) args.push('--preview');
      return waitJob(startJob(preview ? 'compose (preview)' : 'compose', dir, PY, args, async () => {
        const res = [text(outputs(dir))];
        const poster = path.join(dir, 'poster.jpg');
        if (!preview && fs.existsSync(poster)) res.push(await image(poster, 960));
        return res;
      }), wait_seconds);
    },
  },
  {
    name: 'reelly_review',
    description: 'Make contact sheets of the reel and every item, and run the automatic checks (blank frames, layout jumps, near-empty frames, cut-off and too-small text). Returns report.md and the overview sheet; look at each item sheet with reelly_view.',
    schema: { reel: reelArg, preview: { type: 'boolean', description: 'Review reel.preview.mp4 instead of reel.mp4' }, wait_seconds: waitArg },
    required: ['reel'],
    run: async ({ reel, preview, wait_seconds }) => {
      const dir = reelDir(reel);
      const args = [path.join(S, 'review.py'), dir];
      if (preview) args.push('--video', path.join(dir, 'reel.preview.mp4'));
      return waitJob(startJob('review', dir, PY, args, async () => {
        const rv = path.join(dir, 'review');
        const res = [text(fs.readFileSync(path.join(rv, 'report.md'), 'utf8') + '\n' + outputs(dir))];
        if (fs.existsSync(path.join(rv, 'overview.jpg'))) res.push(await image(path.join(rv, 'overview.jpg'), 1600));
        return res;
      }), wait_seconds);
    },
  },
  {
    name: 'reelly_job', readOnly: true,
    description: 'Wait for a running step (capture, compose, ...) and get its result. Without job_id, list all jobs.',
    schema: { job_id: { type: 'string' }, wait_seconds: waitArg },
    run: async ({ job_id, wait_seconds }) => {
      if (!job_id) {
        const rows = [...jobs.values()].map(j => `${j.id}  ${j.status.padEnd(7)}  ${j.label}  ${j.reel ? shown(j.reel) : ''}`);
        return [text(rows.join('\n') || 'No jobs yet.')];
      }
      const job = jobs.get(job_id);
      if (!job) throw new UserError(`No job ${job_id}. Jobs are kept only while the server runs.`);
      return waitJob(job, wait_seconds);
    },
  },
];

// ---------------------------------------------------------------- MCP protocol
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'reelly turns a product that runs in a browser into a cinematic product reel (1080p MP4 with an original score). You do the judgment; these tools do capture, titles, score, compose and review, and never call an AI. Call reelly_guide first and follow it: study, write storyboard.json, capture, titles, score, compose, review, fix. Long steps return a job id: wait with reelly_job.';

function toolList() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
    annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: t.name === 'reelly_study' || t.name === 'reelly_capture' },
  }));
}

const PROMPTS = [{
  name: 'make_reel',
  description: 'Make a product reel of a web product',
  arguments: [
    { name: 'product', description: 'URL, local path, or "demo"', required: true },
    { name: 'notes', description: 'Length, mood, what to show', required: false },
  ],
}];

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case 'initialize': {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return reply({ protocolVersion: v, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'reelly', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: toolList() });
    case 'prompts/list': return reply({ prompts: PROMPTS });
    case 'prompts/get': {
      if (params.name !== 'make_reel') return fail(-32602, `Unknown prompt ${params.name}`);
      const a = params.arguments || {};
      return reply({ description: PROMPTS[0].description, messages: [{ role: 'user', content: text(`Make a product reel of ${a.product || 'demo'}${a.notes ? `. Notes: ${a.notes}` : ''}.\n\nFollow this guide from start to finish:\n\n${guide()}`) }] });
    }
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool ${params.name}`);
      try {
        const r = await tool.run(params.arguments || {});
        return reply(Array.isArray(r) ? { content: r } : r);
      } catch (e) {
        if (!(e instanceof UserError)) log(e.stack || e.message);
        return reply({ isError: true, content: [text(e.message)] });
      }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}

async function handleBody(body) {
  if (Array.isArray(body)) return (await Promise.all(body.map(handle))).filter(Boolean);
  return handle(body);
}

// ---------------------------------------------------------------- stdio transport
function serveStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      handleBody(msg).then(r => { if (r && (!Array.isArray(r) || r.length)) process.stdout.write(JSON.stringify(r) + '\n'); });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`stdio ready, root ${ROOT}`);
}

// ---------------------------------------------------------------- streamable HTTP transport
const MIME = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.wav': 'audio/wav', '.md': 'text/markdown; charset=utf-8' };

function serveHttp() {
  const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      // Finished files: GET /files/<token>/<path inside root>
      if (req.method === 'GET' && parts[0] === 'files' && parts[1] && safeEq(parts[1], TOKEN)) {
        const file = resolveIn(ROOT, decodeURIComponent(parts.slice(2).join('/')), 'file');
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': fs.statSync(file).size });
        fs.createReadStream(file).pipe(res);
        return;
      }
      // MCP endpoint: /mcp/<token>, or /mcp with "Authorization: Bearer <token>"
      if (parts[0] !== 'mcp') { res.writeHead(404).end('not found'); return; }
      const given = parts[1] || bearer;
      if (!given || !safeEq(given, TOKEN)) { res.writeHead(401).end('unauthorized'); return; }
      if (req.method === 'GET') { res.writeHead(405, { allow: 'POST' }).end(); return; } // no server-initiated stream
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 5e6) { res.writeHead(413).end(); return; } }
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
      const out = await handleBody(body);
      if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      if (!(e instanceof UserError)) log(e.stack || e.message);
      if (!res.headersSent) res.writeHead(e instanceof UserError ? 400 : 500).end(e.message);
    }
  });
  server.listen(Number(HTTP_PORT), HTTP_HOST, () => {
    log(`HTTP on http://${HTTP_HOST}:${HTTP_PORT}, root ${ROOT}`);
    log(`MCP URL: ${PUBLIC_URL || `http://${HTTP_HOST}:${HTTP_PORT}`}/mcp/${TOKEN}`);
    log('Anyone with this URL can drive a browser and write files on this machine. Keep it secret.');
  });
}

if (HTTP_PORT) serveHttp(); else serveStdio();
