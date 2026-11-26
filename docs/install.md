# Installing reelly

reelly works in three ways:

| Where | How it plugs in | Who does the judgment |
| --- | --- | --- |
| Claude Code (terminal, desktop app, IDE, on the web) | Plugin: the `/reel` command and the `product-reel` skill | Claude |
| Any MCP host that runs local servers: Codex, Claude Desktop, Cursor, Claude Code | MCP server over stdio (`mcp/server.mjs`) | The host's model |
| ChatGPT | The same MCP server over HTTPS, reachable from the internet | ChatGPT |

In every case the work runs on one machine that has the requirements below, and nothing calls an AI API.

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

## Codex

Codex runs local MCP servers, so it gets reelly through the MCP server.

```
git clone https://github.com/toneflix/reelly ~/reelly
cd ~/reelly/scripts && npm install && npx playwright install chromium && python3 -m pip install -r requirements.txt && ./doctor
codex mcp add reelly -- node ~/reelly/mcp/server.mjs
```

Or add it to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`) yourself:

```toml
[mcp_servers.reelly]
command = "node"
args = ["/Users/you/reelly/mcp/server.mjs"]
tool_timeout_sec = 120
```

Then ask Codex, in your product's folder: "Make a product reel of http://localhost:5173 with the reelly tools." Codex should call `reelly_guide` first; say so if it doesn't. Capture and compose take minutes, longer than a tool call may last, so those tools hand back a job id after about 45 seconds and Codex waits with `reelly_job`.

Reels are made under `reels/` in the folder the server starts in. Pass `--root /path/to/project` in `args` to pin it, or have Codex give `reelly_init` an absolute `folder`.

Working inside a clone of this repository, Codex also reads [`AGENTS.md`](../AGENTS.md), which tells it to follow the skill with the scripts directly, no MCP needed.

## Claude Desktop, Cursor and other MCP hosts

Any host that launches stdio servers takes the same command. In Claude Desktop's `claude_desktop_config.json`, Cursor's `.cursor/mcp.json` and most others:

```json
{
  "mcpServers": {
    "reelly": {
      "command": "node",
      "args": ["/Users/you/reelly/mcp/server.mjs", "--root", "/Users/you/reels-home"]
    }
  }
}
```

In Claude Code you can also skip the plugin and use the server: `claude mcp add reelly -- node /path/to/reelly/mcp/server.mjs`. The plugin is the better fit there, because Claude Code already has a shell and file tools.

The server also offers a `make_reel` prompt (product, notes) for hosts that show MCP prompts.

## ChatGPT

ChatGPT can only use MCP servers it reaches over the internet (SSE or streaming HTTP). It cannot start a program on your computer. So using reelly from ChatGPT means you run the server on a machine you control and give ChatGPT a public HTTPS address for it:

```
node mcp/server.mjs --http 8765 --root ~/reels-home --public-url https://<your-tunnel-host>
cloudflared tunnel --url http://127.0.0.1:8765      # or: ngrok http 8765
```

The server prints its MCP URL, `https://<your-tunnel-host>/mcp/<token>`. In ChatGPT on the web, add it as a custom MCP server (Settings, then Plugins or Connectors depending on your plan; see OpenAI's [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server) guide) with **No authentication**: the random token in the URL is the secret. Pass `--token` to choose one, or `REELLY_TOKEN`.

What to expect:

- **Your plan must allow custom MCP servers** (developer mode). OpenAI decides which plans and workspaces have it.
- **Everything happens on the server's machine.** The product URL must be reachable from there (`localhost` means that machine), and the reel is written there. Tool results include download links for `reel.mp4` and `poster.jpg` under `/files/<token>/...` when you pass `--public-url`.
- **ChatGPT has no file tools there**, so it writes `storyboard.json` with `reelly_write_file` and reads results with `reelly_read_file` and `reelly_view`.
- **Expect confirmations.** ChatGPT asks before each tool that changes something, and capture and compose run as jobs it has to wait on with `reelly_job`. If it stops waiting, tell it to keep going.
- **Contact sheets come back as images.** Whether ChatGPT looks at images returned by a tool depends on its current model and client; reelly hasn't been tested end to end in ChatGPT. If it can't see them, its review rests on `report.md` alone and you should watch the reel yourself.
- **Security.** Anyone with the URL can open web pages in a headless browser on that machine, write files under `--root`, and run code there (a reel's `setup.js` is JavaScript that capture runs). Treat the URL like a password. Stop the tunnel when you're done, and run the server in a container or on a machine where that is acceptable. In HTTP mode every path is confined to `--root`.

## The MCP tools

| Tool | Does |
| --- | --- |
| `reelly_guide` | The whole procedure (the skill), mapped to these tools. Read first. |
| `reelly_doctor` | Checks the machine. |
| `reelly_init` | Makes a reel folder; `demo: true` starts from the Lumen example. |
| `reelly_study` | Crawls the product; returns `study.json` and the screenshots. |
| `reelly_write_file`, `reelly_read_file`, `reelly_list` | Files inside a reel folder (JSON is checked before writing). |
| `reelly_view` | An image from the reel folder (contact sheet, screenshot, frame, poster) as a JPEG. |
| `reelly_capture` | Films shots and montages (`only` to re-capture some). |
| `reelly_titles` | Renders titles to PNG. |
| `reelly_score` | Synthesises the score, or with `track` fits the storyboard to a song. |
| `reelly_compose` | Cuts the reel (`preview` for a fast half-size pass). |
| `reelly_review` | Contact sheets and automatic checks; returns `report.md` and the overview. |
| `reelly_job` | Waits for a long step and returns its result. |
