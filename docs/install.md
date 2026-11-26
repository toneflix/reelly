# Installing reelly

reelly runs as a Claude Code plugin: the `/reel` command and the `product-reel` skill. The work runs on one machine that has the requirements below, and nothing calls an AI API.

## Requirements (every option)

Node 22+, Python 3.11+ with numpy, scipy and Pillow, ffmpeg with libx264 and aac, and Playwright with Chromium. From the plugin or clone folder:

```
cd scripts
npm install
npx playwright install chromium
python3 -m pip install -r requirements.txt
./doctor
```

`scripts/doctor` prints the fix for anything missing. If the Playwright Chromium download is blocked but the machine already has Chrome or Chromium, set `REELLY_CHROMIUM` to that binary; reelly also tries a preinstalled Chromium on its own when the matching Playwright build is missing.

## Claude Code on your computer

In a Claude Code session (terminal, desktop app's Code tab, VS Code or JetBrains):

```
/plugin install reelly --marketplace toneflix/reelly
```

That needs Claude Code 2.1.275 or later. On older versions, add the marketplace first:

```
/plugin marketplace add toneflix/reelly
/plugin install reelly@reelly
```

From your shell, the same is `claude plugin install reelly --marketplace toneflix/reelly`. Then run `/reel demo`. The first run starts with `doctor`; if something is missing, Claude shows the fix and can run the install commands in the plugin's `scripts` folder for you.

To try a local clone without installing: `claude --plugin-dir ./reelly`.

### For a whole team, through the repository

Commit this to the product repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "reelly": { "source": { "source": "github", "repo": "toneflix/reelly" } }
  },
  "enabledPlugins": { "reelly@reelly": true }
}
```

Claude Code registers the marketplace once a contributor trusts the folder. Each contributor then runs `claude plugin install reelly@reelly --scope project` once per clone.

## Claude Code on the web (cloud sessions)

Cloud sessions start from a fresh clone on an Anthropic-hosted machine, so plugins installed on your computer don't carry over, and a cloud session ignores the marketplaces a repository lists in `.claude/settings.json`. Use one of these:

1. **Add it to your claude.ai account (recommended).** Go to [claude.ai/customize/plugins](https://claude.ai/customize/plugins), add the marketplace `toneflix/reelly` and turn on `reelly`, then start a new session. Plugins you turn on there are synced into every cloud session.
2. **Ship it in the repository.** Copy this repository into the product repository at `.claude/skills/reelly/` (it already has `.claude-plugin/plugin.json`, so Claude Code loads it as a skills-directory plugin from the clone). This is the way to give it to everyone who opens a cloud session on that repository, at the cost of vendoring the files.

Then make sure the cloud environment can run the scripts:

- **ffmpeg and the Python packages**: put them in the environment's setup script, for example `apt-get install -y ffmpeg && python3 -m pip install numpy scipy pillow`.
- **Node packages**: Claude runs `npm install` in the plugin's `scripts` folder when `doctor` asks for it. The environment's network access must allow the npm registry and PyPI.
- **Chromium**: Anthropic's cloud images ship a Chromium, and reelly falls back to it when the Playwright build it expects is not downloaded, so `npx playwright install chromium` is usually not needed.

A product on `localhost` must run inside the cloud session too (start its dev server there), and the finished `reel.mp4` is in the session's clone: commit it, or download it from the session.
