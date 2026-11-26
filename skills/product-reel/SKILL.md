---
name: product-reel
description: Make a cinematic product reel (1080p30 MP4 with an original synthesised score) of any product that runs in a browser, by studying it, writing a beat-grid storyboard, and driving deterministic capture, compose and score scripts. Use for /reel, or when asked for a product video, trailer, teaser or demo reel of a web app or site.
---

# Product reel

You make the judgment calls (what the product is, what to show, the words, the pacing). The scripts in `${CLAUDE_PLUGIN_ROOT}/scripts` do the machinery and never call an AI API. Keep all product-specific knowledge in the storyboard and an optional `setup.js`; never edit the scripts for one product.

`S=${CLAUDE_PLUGIN_ROOT}/scripts` below. If the variable is not expanded, the plugin root is two directories above this file.

## 0. Check the machine

Run `$S/doctor`. If something is missing, show the user the fix it prints and stop until it passes.

## 1. Study the product

Pick a short name (lowercase, no spaces) and make `reels/<name>/` in the user's project. For `demo`, copy `${CLAUDE_PLUGIN_ROOT}/examples/lumen/storyboard.json` there, set its `url` to the absolute path of `${CLAUDE_PLUGIN_ROOT}/examples/demo`, and skip to step 3.

```
node $S/capture.mjs study <url-or-path> reels/<name>/study --max 12
```

This crawls same-origin links, saves a screenshot per page and `study.json` (headings, buttons with selectors, inputs, visible text, README/docs next to a local product). Look at every screenshot. Also read the project's README, docs and routes if the product is in this repo. Work out:

- what the product is for, in one sentence a stranger understands;
- its 3 to 5 most visual moments (something moves, appears, fills in or connects);
- the selectors and routes that reach each moment, and sample data it needs;
- anything that should not be in a reel (cookie banners, dev toolbars, "beta" ribbons, debug overlays): put them in `hide`.

If a moment needs sign-in, seeded data or a feature flag, write `reels/<name>/setup.js` (see "setup.js" below) instead of hacks in actions.

If the product is a mobile app (Expo or React Native), follow "Mobile apps and Expo" below before you study it, and study with `--device phone`.

## 2. Write `reels/<name>/storyboard.json`

### Schema

```jsonc
{
  "name": "lumen",
  "url": "http://localhost:5173",          // or an absolute/relative path to a folder or .html file (served locally)
  "product": { "name": "Lumen", "tagline": "Notes that think with you.", "url": "lumen.app" },
  "fps": 30, "bpm": 120, "beatsPerBar": 4,  // 120 BPM: a beat is 15 frames, a bar 60 frames (2 s)
  "viewport": { "width": 1920, "height": 1080, "deviceScaleFactor": 1.5 },
  "device": "phone",                        // optional: "phone" | "tablet" | { "type": "phone", "align": "center", "color": "#1b1c21", "frame": true, "statusBar": true }
  "colorScheme": "dark",                    // or "light"
  "hide": ["#cookie-banner"],               // CSS selectors hidden in every capture
  "setup": "setup.js",                      // optional hook module, relative to the reel folder
  "font": { "family": "Inter Tight", "weights": [300, 600, 800] },   // any Google Font; "url" for a custom stylesheet
  "theme": { "background": "#07080d", "text": "#f4f4ff", "accent": "#8f82ff" },  // title cards; take the accent from the product
  "music": { "mode": "synth", "key": "D", "seed": 7 },               // or { "file": "track.mp3", "offset": 0.42, "sfx": true }
  "poster": { "item": "endcard", "at": 10 },                         // item id + beats into it
  "vignette": 0.22,

  "sections": [                              // in order; length = sum of their items
    { "id": "open", "bars": 4, "energy": 0.15, "cut": "dissolve" },  // energy 0..1 drives drums, ostinato filter, drone
    { "id": "rush", "bars": 4, "energy": 1.0,  "cut": "hard" }       // cut: hard | dissolve | flash
  ],

  "timeline": [                              // plays in order, back to back, on the beat grid
    { "type": "title", "id": "opener", "section": "open", "bars": 2, "style": "opener", "reveal": "words",
      "text": "Every idea needs a *home.*" },               // *word* = bold emphasis

    { "type": "shot", "id": "editor", "section": "write", "bars": 4,
      "path": "/#/editor",                                  // appended to url
      "prepare": [ { "do": "click", "target": "#new" } ],   // instant, before frame 0, not filmed
      "settle": 1,                                          // seconds of clock run after prepare (default 1)
      "cursor": [1500, 860],                                // where the pointer starts
      "actions": [                                          // "at" and "beats" are beats from the start of the shot
        { "at": 2,   "do": "click", "target": "#typing-line", "beats": 1.5 },  // pointer travels for "beats", clicks ON "at"
        { "at": 2.5, "do": "type",  "text": "Ship it.", "beats": 4 },          // keys spread over "beats"
        { "at": 8,   "do": "drag",  "from": "#card-2", "to": "#col-done", "toOffset": [0, 120], "via": [[900, 400]], "beats": 3.5 },
        { "at": 12,  "do": "scroll", "by": 600, "in": ".list", "beats": 3 },  // or "to": selector | y
        { "at": 14,  "do": "hover", "target": ".row" },
        { "at": 15,  "do": "press", "key": "Enter" },
        { "at": 15,  "do": "call",  "fn": "loadSample" }                       // setup.js actions.loadSample(page)
      ],
      "camera": [                                           // keyframes, eased between; zoom 1..1.6
        { "at": 0, "zoom": 1.0 },
        { "at": 2.5, "zoom": 1.4, "center": "#typing-line", "offset": [200, 0] },   // selector, [x, y] CSS px, or "cursor"
        { "at": 8, "zoom": 1.2, "center": "cursor", "ease": "inOut" }               // ease: inOut | out | in | linear | hold
      ],
      "titles": [ { "at": 1, "beats": 6, "style": "lower", "text": "Write it down." } ] },

    { "type": "montage", "id": "rush", "section": "rush",
      "pattern": [[4, 2], [4, 1], [8, 0.5]],               // [count, beats]: 4 x 1 s, 4 x 0.5 s, 8 x 0.25 s at 120 BPM
      "slides": [
        { "path": "/#/board", "zoom": 1.25, "center": "#col-doing", "push": 0.04 },  // still + slow push-in
        { "path": "/#/insights", "settle": 2.5, "scroll": 400, "hover": ".bar" },
        { "from": "editor", "at": 10, "zoom": 1.4, "center": [900, 500] }           // a frame of a captured shot
      ] },

    { "type": "title", "id": "endcard", "section": "end", "bars": 4, "style": "endcard" }   // name, tagline, url from "product"
  ],

  "cues": [                                   // music on the bar grid; "beat" is optional
    { "bar": 4,  "type": "hit" },
    { "bar": 8,  "type": "riser", "bars": 2 },             // ends exactly at bar 10
    { "bar": 10, "type": "impact", "flash": true },        // boom + crack + sub tail, white flash
    { "bar": 16, "type": "braam" },
    { "bar": 24, "type": "roll", "bars": 1.5 },            // snare roll that speeds up
    { "bar": 25, "beat": 2, "type": "silence", "beats": 2 },   // dead silence: half a bar before the final hit
    { "bar": 26, "type": "impact", "flash": true }, { "bar": 26, "type": "braam" },
    { "bar": 12, "type": "whoosh" }
  ]
}
```

Title styles: `opener` (large, light, centred), `word` (one huge line), `center`, `lower` (lower third over a shot), `endcard`. `reveal: "words"` brings words in on beats; the end card reveals name, tagline and URL line by line.

Item ids must be unique (letters, digits, `-`, `_`, `.`). Shots are the only items with live actions; montages and titles are built from stills and PNGs.

### Pacing rules

- Length: what the user asked for, default 60 s, never over 90 s. At 120 BPM, 60 s is 30 bars; 90 s is 45 bars. Pick a BPM from the mood (calm 96 to 110, standard 120, urgent 128 to 140) and recount bars.
- Every item is a whole number of beats, and every section a whole number of bars. Cuts therefore land on the grid.
- Shape: quiet open (title + establishing shot, dissolves, energy at most 0.3) → build (2 to 3 feature shots, energy rising 0.4 → 0.8, hard cuts) → montage at full energy → a one-line lift → half a bar of silence → final hit on the end card. A riser leads into each big change.
- Dissolves only where energy is below 0.6; compose turns any other dissolve into a hard cut. Use `flash` cuts only on big hits (one to three per reel).
- Natural interaction speed: a page turn, drag or scroll takes 1.5 to 2 s (3 to 4 beats at 120 BPM). Pointer travel before a click is about 1 beat. Typing runs at most about 8 characters per second. Leave a beat after a click for the UI to respond before cutting.
- Put the moment that matters on a beat: clicks land on `at`, drags release on `at + beats`. Start actions after `at: 1` so the viewer can read the frame first.
- Camera: at most 1.6x (capture is 1.5x, so this stays sharp); 2.4x with a `device`. Push in to where the action is just before it happens; pull out to reveal the result. Use `"center": "cursor"` to follow drags. One or two moves per shot is plenty.
- Montages: at least 16 slides that speed up (for example 4 x 1 s, 4 x 0.5 s, 8 x 0.25 s). Each slide is a different place or crop; vary zoom and centre. `from` slides reuse frames from shots.
- Shots are 2 to 4 bars. Nothing on screen without something happening for more than about 4 s.

### Copy rules

- Describe what the product does for someone, not its feature list. "Bring everyone in." beats "Real-time collaboration with granular permissions".
- Few words: opener at most 6, lower thirds 2 to 4, lift line at most 4. Plain words, sentence case, a full stop is fine.
- An opening line that states the problem or promise, one lower third per feature shot at most, and an end card with the product name, tagline and URL. Nothing else on screen.
- Use the product's real name and tagline from its site or README; do not invent claims, numbers or customers.

## 3. Capture

```
node $S/capture.mjs reels/<name>                    # all shots and montages
node $S/capture.mjs reels/<name> --only editor,rush # re-capture just these
```

It drives Chromium frame by frame at the storyboard viewport (1920x1080 at deviceScaleFactor 1.5 by default), writing `frames/<id>/NNNNN.jpg` and `manifest.json` (layout, interaction frames, cursor track, resolved camera keyframes, text boxes for the review). Time is deterministic: the page clock is installed before load, paused after load and advanced exactly one frame per screenshot; CSS animations, transitions and videos are paused and stepped from the same clock. The pointer is drawn as a cursor with a click ripple. Expect about 6 to 8 captured frames per second.

If a selector is missing or the product throws errors, fix the storyboard (or `setup.js`) and capture again. Errors the page throws are recorded and reported by the review.

## 4. Titles, score, compose

```
node $S/titles.mjs reels/<name>       # transparent PNGs with real web fonts
python3 $S/music.py reels/<name>      # score.wav + score.json (every placed sound with its time)
python3 $S/compose.py reels/<name> --preview   # half size, fast: use while iterating
python3 $S/compose.py reels/<name>             # final reel.mp4 + poster.jpg
```

For the user's own track (`/reel ... --music song.mp3` or "use this song"):

```
python3 $S/music.py analyze song.mp3 reels/<name>
```

This detects tempo and downbeat and rewrites `bpm` and `music` in the storyboard. Then re-capture everything (actions are timed in beats) and continue. The edit then cuts on the song's beats; `music.sfx` (default true) still adds clicks, whooshes and slide ticks under it.

## 5. Review and fix

```
python3 $S/review.py reels/<name>            # add --video reels/<name>/reel.preview.mp4 when reviewing a preview
```

Read `review/report.md`, then look at `review/overview.jpg` and every `review/<item>.jpg`. Check, and fix what you find:

- [ ] No blank, black, half-loaded or broken frames (spinners, skeletons, missing images, error pages).
- [ ] Nothing important cut off by the frame or the camera crop: headlines, the element being clicked, dialogs.
- [ ] No near-empty frames: if a shot is mostly background, zoom in or choose a fuller state.
- [ ] Text readable at 1080p: body text at least about 15 px on screen. Zoom in where the report says text is small.
- [ ] No layout jumps: the report lists sudden brightness or pixel changes that no cut, flash or interaction explains. Look at those frames; usually a late-loading font, image or banner. Add to `hide`, wait in `prepare`, or raise `settle`.
- [ ] The cursor is where the action is and moves like a hand; clicks visibly change something.
- [ ] Titles are legible over what is behind them and never cover the action.
- [ ] Every montage slide is different and the montage speeds up.
- [ ] Cuts, title reveals and interactions line up with entries in `score.json` (impacts on section changes, ticks on clicks and slides, silence just before the final hit).
- [ ] Length is what the user asked for.

Fix in the storyboard, re-capture only the shots you changed with `--only`, then re-run titles (if copy changed), music and compose, and review again. Two or three rounds is normal.

When done, report to the user: the path of `reel.mp4`, `poster.jpg` and `storyboard.json`; what the review caught and you fixed; and what you could not check. You cannot hear the audio, so say that the score was checked only through `score.json` timings and levels.

## Mobile apps and Expo

A mobile app is filmed through its web build, inside a phone frame. Signs that the product is one: `expo` or `react-native` in `package.json`, or an `app.json` with an `"expo"` key.

1. Make sure it builds for web. Expo needs `react-dom`, `react-native-web` and `@expo/metro-runtime`; if they are missing, ask the user before running `npx expo install react-dom react-native-web @expo/metro-runtime` in their project.
2. Get a URL. Prefer a static export, which is deterministic and needs no server: `npx expo export -p web` writes `dist/`, and `url` can point at that folder (client-side routes fall back to `index.html`; Expo Router's static pages are served as `<route>.html`). Otherwise run `npx expo start --web` in the background and use its URL (usually `http://localhost:8081`).
3. Study at phone size: `node $S/capture.mjs study <url-or-dist> reels/<name>/study --max 12 --device phone`.
4. In the storyboard set `"device": "phone"` (or `"tablet"`). The viewport becomes 390x844 (tablet 820x1180) with touch and a mobile user agent, captured at 3x (tablet 2x). Compose places the screen in a generic device frame with a status bar on the theme background; the camera moves the whole stage, so zoom 1 shows the full phone and 2 to 2.4 fills the frame with part of the screen. `"align": "left"` or `"right"` moves the phone off centre to leave room for titles.
5. Clicks are taps: a fingertip dot appears only while pressed, so there is no pointer to watch travel. Leave about a beat between taps. Scroll the app's own scroll view with `"in"` (for example `"in": "#feed"`), since React Native screens rarely scroll the page.
6. React Native Web turns `testID` into `data-testid` and `nativeID` into `id`, so target `[data-testid="add"]` or `#new-habit`. The study lists them.

The web build cannot show native-only features: camera, maps, push notifications, haptics, biometrics, in-app purchases and other native modules render nothing, a fallback, or throw. Check the study screenshots and the review's page errors, leave those moments out, and tell the user which features the reel could not show. Filming the native app in an iOS Simulator or Android emulator is not supported.

## setup.js

Optional ES module next to the storyboard, for product-specific setup the scripts must not contain:

```js
export async function beforeEach({ context, page, baseURL, item }) {
  // runs before every page load: cookies, localStorage, auth headers
  await context.addCookies([{ name: 'session', value: 'demo', url: baseURL }]);
}
export async function afterLoad({ page, item }) {
  // runs after load, before the clock is paused: sign in, seed data
}
export const actions = {
  // callable from a shot with { "do": "call", "fn": "loadSample" }
  async loadSample(page, { args }) { await page.evaluate(() => window.app.loadSample()); },
};
```
