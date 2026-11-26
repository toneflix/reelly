# AGENTS.md

Instructions for coding agents (Codex, Claude Code, Cursor and others) working in this repository.

## What this is

reelly turns a product that runs in a browser into a cinematic product reel: a 1080p30 MP4 with an original score, a poster frame and an editable storyboard. You, the agent, make the judgment calls (what the product is, what to show, the words, the pacing, reviewing the result). The scripts in `scripts/` do the machinery deterministically and never call an AI API. There is no API key.

## Making a reel

The full procedure is in [`skills/product-reel/SKILL.md`](skills/product-reel/SKILL.md). Read it before you start and follow it from start to finish: doctor, study, storyboard, capture, titles, score, compose, review and fix.

The skill is written for Claude Code and uses `${CLAUDE_PLUGIN_ROOT}`. Outside Claude Code, that is the root of this repository, so `S=scripts` (or the absolute path of `scripts/` when the reel lives in another project):

```
scripts/doctor
node scripts/capture.mjs study <url-or-path> reels/<name>/study --max 12
# write reels/<name>/storyboard.json (and setup.js if needed)
node scripts/capture.mjs reels/<name> [--only id,id]
node scripts/titles.mjs reels/<name>
python3 scripts/music.py reels/<name>
python3 scripts/compose.py reels/<name> [--preview]
python3 scripts/review.py reels/<name>
```

Look at every study screenshot and every contact sheet in `reels/<name>/review/` before you call the reel done. Capture takes about 3 minutes for 60 s of reel, and compose 1 to 2 minutes, so give those commands a long timeout.

If you are connected to the reelly MCP server (`mcp/server.mjs`), use its tools instead of the shell: call `reelly_guide` first.

## Rules for changing the code

- Keep the scripts generic. Nothing in `scripts/` or `mcp/` may know about one product; product specifics belong in a reel's `storyboard.json` or `setup.js`.
- Never add a call to an AI API or anything that needs an API key or account.
- `mcp/server.mjs` has no npm dependencies, so it starts before `npm install`. Keep it that way.
- The skill (`skills/product-reel/SKILL.md`) is the single source of the procedure. The MCP server serves it through `reelly_guide`; do not copy it elsewhere.
- Check a change by running the demo end to end (`README.md`, "Try it without an agent").
