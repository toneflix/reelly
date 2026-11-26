// Launches Playwright's Chromium, or REELLY_CHROMIUM / a preinstalled Chromium
// when Playwright's own build is missing.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function candidates() {
  const out = ['/opt/pw-browsers/chromium'];
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try { out.push(execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  }
  return out.filter(p => p && fs.existsSync(p));
}

export async function launchChromium(chromium, opts = {}) {
  if (process.env.REELLY_CHROMIUM) return chromium.launch({ ...opts, executablePath: process.env.REELLY_CHROMIUM });
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!/Executable doesn't exist|browserType\.launch.*(not found|ENOENT)/is.test(e.message)) throw e;
    for (const exe of candidates()) {
      try { return await chromium.launch({ ...opts, executablePath: exe }); } catch {}
    }
    throw e;
  }
}
