# reelly

A Claude Code plugin that turns any product that runs in a browser into a cinematic product reel: a 1080p30 MP4 with an original score, a poster frame and the editable storyboard that made it.

```
/reel http://localhost:5173 "60s, suspenseful, show the editor and sharing"
/reel ./dist
/reel demo
```

It uses only the Claude Code session it runs in. There is no API key, no account and no cloud service: Claude does the judgment (studying the product, writing the storyboard and copy, reviewing the result) and local scripts do the machinery (capture, titles, score, compose).

Output lands in `reels/<name>/`:

| File | What it is |
| --- | --- |
| `reel.mp4` | H.264 1920x1080 30 fps, CRF 17, yuv420p, faststart, AAC 256k |
| `poster.jpg` | Poster frame |
| `storyboard.json` | The plan: tempo, sections, shots, actions, camera, montages, titles, music cues. Edit and re-render. |
| `setup.js` | Optional hook for signing in, seeding data or feature flags |
| `review/` | Contact sheets and the automatic review report |
| `frames/`, `titles/`, `manifest.json`, `score.wav`, `score.json` | Intermediate files |

## Requirements

- Node 22 or newer
- Python 3.11 or newer with numpy, scipy and Pillow
- ffmpeg with libx264 and aac
- Playwright with Chromium

```
cd <plugin>/scripts
npm install
npx playwright install chromium
python3 -m pip install -r requirements.txt
./doctor
```

`scripts/doctor` checks every requirement and prints the fix for anything missing.

## Install

```
/plugin marketplace add toneflix/reelly
/plugin install reelly
```

Or clone this repository and point Claude Code at it with `claude --plugin-dir ./reelly`.

## How it works

1. **Study.** `capture.mjs study` crawls the product in headless Chromium, takes screenshots and records headings, buttons, inputs and text. Claude reads them, plus the README and docs, and writes `storyboard.json`.
2. **Capture.** `capture.mjs` films each shot frame by frame at 1920x1080 with deviceScaleFactor 1.5, so the camera can zoom to 1.6x later without blur. Time is deterministic: `page.clock.install()` before load, `page.clock.pauseAt()` after load, then exactly `runFor(1000/30)` per frame. CSS animations, transitions and videos are paused and stepped from the same clock. The pointer moves along eased, slightly curved paths like a hand, drawn as a cursor with a click ripple.
3. **Titles.** `titles.mjs` renders titles from HTML to transparent PNGs, so real web fonts work.
4. **Score.** `music.py` synthesises an original trailer score on the same beat grid: a drone with a moving low-pass, a 16th-note ostinato of band-limited saw stabs whose filter opens section by section, taiko drums, impacts (boom, crack, sub tail), braams, risers, whooshes, ticks, an accelerating snare roll, a dead-silent half bar before the last hit, convolution reverb per bus and a soft-clipped master at -1 dBFS. Every cut, click, drag, slide change, camera move and title reveal gets a sound. Or bring a track: `music.py analyze song.mp3 reels/<name>` detects its tempo and downbeat and snaps the storyboard to them.
5. **Compose.** `compose.py` crops for camera moves, cuts on the beat (hard cuts in action, dissolves only in calm sections, white flashes on big hits), overlays titles, adds a light vignette and pipes raw frames to ffmpeg.
6. **Review.** `review.py` makes contact sheets of the whole reel and of every shot, and checks for blank frames, layout jumps, near-empty frames, text cut off by the camera and text too small to read. Claude looks at them, fixes the storyboard, re-captures only the affected shots and composes again.

The scripts are generic: nothing in them knows about any one product, and none of them calls an AI API. See [`skills/product-reel/SKILL.md`](skills/product-reel/SKILL.md) for the full storyboard schema, pacing and copy rules and the review checklist.

## Try it without Claude

The demo product and its storyboard are in `examples/`:

```
S=scripts R=examples/lumen
node $S/capture.mjs $R
node $S/titles.mjs $R
python3 $S/music.py $R
python3 $S/compose.py $R
python3 $S/review.py $R
open $R/reel.mp4
```

A full 60 s capture takes about 3 minutes and composing about 1 to 2 minutes on a 4-core machine.

## Layout

```
.claude-plugin/plugin.json
commands/reel.md               /reel <url|path|demo> [notes]
skills/product-reel/SKILL.md   the procedure, schema, pacing and copy rules, review checklist
scripts/capture.mjs            study crawl + deterministic frame capture
scripts/titles.mjs             HTML titles -> transparent PNG
scripts/music.py               score synthesis, user-track beat detection
scripts/compose.py             camera, cuts, titles, vignette -> ffmpeg
scripts/review.py              contact sheets and automatic checks
scripts/lib/storyboard.mjs     storyboard loading and beat-grid layout
scripts/doctor                 requirement check
scripts/requirements.txt, scripts/package.json
examples/demo/                 Lumen, a small demo product
examples/lumen/storyboard.json the example storyboard (60 s, 120 BPM)
```

## License

MIT
