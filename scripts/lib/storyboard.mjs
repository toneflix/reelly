// Shared storyboard loading, validation and beat-grid layout.
// Everything on the timeline is measured in beats; frames are derived here once.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ZOOM = 1.6;

export function loadStoryboard(reelDir) {
  const file = path.join(reelDir, 'storyboard.json');
  if (!fs.existsSync(file)) throw new Error(`No storyboard at ${file}`);
  const sb = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalise(sb);
}

export function normalise(sb) {
  sb.fps ??= 30;
  sb.bpm ??= 120;
  sb.beatsPerBar ??= 4;
  sb.viewport = { width: 1920, height: 1080, deviceScaleFactor: 1.5, ...(sb.viewport || {}) };
  sb.hide ??= [];
  sb.sections ??= [];
  sb.timeline ??= [];
  sb.cues ??= [];
  sb.music ??= { mode: 'synth' };
  sb.timeline.forEach((it, i) => {
    it.id ??= `${it.type}-${i}`;
    if (!/^[\w.-]+$/.test(it.id)) throw new Error(`Item id "${it.id}" must be letters, digits, - _ or .`);
  });
  const ids = new Set();
  for (const it of sb.timeline) {
    if (ids.has(it.id)) throw new Error(`Duplicate item id "${it.id}"`);
    ids.add(it.id);
  }
  return sb;
}

export const framesPerBeat = sb => (sb.fps * 60) / sb.bpm;

/** Length of a timeline item in beats. */
export function itemBeats(sb, it) {
  if (it.type === 'montage') {
    return montageDurations(it).reduce((a, b) => a + b, 0);
  }
  if (it.beats != null) return it.beats;
  if (it.bars != null) return it.bars * sb.beatsPerBar;
  throw new Error(`Item "${it.id}" needs "bars" or "beats"`);
}

/** Expand a montage pattern [[count, beats], ...] into one duration per slide. */
export function montageDurations(it) {
  const pattern = it.pattern || [[4, 2], [4, 1], [8, 0.5]];
  const out = [];
  for (const [count, beats] of pattern) for (let i = 0; i < count; i++) out.push(beats);
  return out;
}

/**
 * Lay the timeline out on the frame grid. Start frames are rounded from beat
 * positions, so non-integer frames-per-beat never accumulates drift.
 */
export function layout(sb) {
  const fpb = framesPerBeat(sb);
  const f = beats => Math.round(beats * fpb);
  const warnings = [];
  let beat = 0;
  const items = sb.timeline.map((it, index) => {
    const beats = itemBeats(sb, it);
    const start = f(beat);
    const end = f(beat + beats);
    const entry = { index, id: it.id, type: it.type, section: it.section, startBeat: beat, beats, start, frames: end - start };
    if (it.type === 'montage') {
      let b = beat;
      entry.slides = montageDurations(it).map((d, k) => {
        const s = { k, start: f(b) - start, frames: f(b + d) - f(b), beats: d };
        b += d;
        return s;
      });
      if (entry.slides.length < 16) warnings.push(`Montage "${it.id}" has ${entry.slides.length} slides; the bar is at least 16.`);
      const ds = montageDurations(it);
      for (let k = 1; k < ds.length; k++) if (ds[k] > ds[k - 1]) { warnings.push(`Montage "${it.id}" slows down at slide ${k}; slides should speed up.`); break; }
    }
    beat += beats;
    return entry;
  });

  // Sections: explicit order from sb.sections, spans from the items that use them.
  const sections = sb.sections.map(s => {
    const mine = items.filter(i => i.section === s.id);
    if (!mine.length) { warnings.push(`Section "${s.id}" has no items.`); return { ...s, start: 0, frames: 0, startBeat: 0, beats: 0 }; }
    const startBeat = mine[0].startBeat;
    const beats = mine.reduce((a, i) => a + i.beats, 0);
    if (s.bars != null && Math.abs(s.bars * sb.beatsPerBar - beats) > 1e-6)
      warnings.push(`Section "${s.id}" says ${s.bars} bars but its items add up to ${beats / sb.beatsPerBar}.`);
    return { ...s, energy: s.energy ?? 0.5, cut: s.cut ?? 'hard', startBeat, beats, start: f(startBeat), frames: f(startBeat + beats) - f(startBeat) };
  });
  for (const it of items) if (it.section && !sections.find(s => s.id === it.section)) warnings.push(`Item "${it.id}" uses unknown section "${it.section}".`);

  const totalBeats = beat;
  const totalFrames = f(totalBeats);
  const seconds = totalFrames / sb.fps;
  if (seconds > 90.5) warnings.push(`Reel is ${seconds.toFixed(1)} s; the maximum is 90 s.`);

  const cues = sb.cues.map(c => {
    const b = (c.bar ?? 0) * sb.beatsPerBar + (c.beat ?? 0);
    return { ...c, atBeat: b, frame: f(b) };
  });
  return { fps: sb.fps, bpm: sb.bpm, beatsPerBar: sb.beatsPerBar, fpb, totalBeats, totalFrames, seconds, items, sections, cues, warnings };
}

/** Convert an item-relative beat position into an item-relative frame. */
export const beatToFrame = (sb, beats) => Math.round(beats * framesPerBeat(sb));
