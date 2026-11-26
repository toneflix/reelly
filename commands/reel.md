---
description: Turn a product that runs in a browser into a cinematic product reel (MP4 with an original score)
argument-hint: <url or local path | demo> [notes, e.g. "60s, suspenseful, show the editor and sharing"]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Make a product reel with the `product-reel` skill.

Arguments: $ARGUMENTS

- The first argument is the product: an http(s) URL (for example a dev server on localhost), a local folder or HTML file, or the word `demo` for the Lumen demo that ships with this plugin. A mobile app (Expo or React Native) is filmed through its web build at phone size; the skill's "Mobile apps and Expo" section says how.
- Everything after it is the user's notes: length (default 60 s, at most 90 s), mood, and what to show.

The plugin's scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts`. Follow the skill from start to finish: doctor, study, storyboard, capture, titles, score, compose, review and fix. Finish by telling the user where `reels/<name>/reel.mp4`, `poster.jpg` and `storyboard.json` are, what the review found and fixed, and what you could not check (you cannot hear the audio).
