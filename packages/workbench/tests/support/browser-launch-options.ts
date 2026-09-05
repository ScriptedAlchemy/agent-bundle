import type { LaunchOptions } from 'playwright';

/**
 * Environment variable that selects the browser binary every Workbench browser
 * suite launches — the shared `e2e` fixture in workbench-e2e.ts and its
 * per-file forks, the raw `chromium.launch()` suites, and the nightly
 * capture-runtime-playground.mjs driver all read {@link browserLaunchOptions}:
 *
 * - unset (or empty) or `chrome` — branded Google Chrome (`channel: 'chrome'`),
 *   the local developer default: whichever Chrome stable the machine has.
 * - `chromium` — Playwright's bundled Chromium for the installed Playwright
 *   version (`pnpm exec playwright install chromium`). CI sets this so a run
 *   tests one build, cached by Playwright version, instead of the Chrome the
 *   runner image happens to ship that week.
 *
 * Any other value fails at module load rather than silently launching the
 * wrong browser.
 *
 * Playwright locates bundled browsers from `PLAYWRIGHT_BROWSERS_PATH`, else
 * (on Linux) from `XDG_CACHE_HOME`/`~/.cache` + `ms-playwright`, resolved once
 * when `playwright` is first imported. Rstest workers run under
 * rstest.worker-isolation.ts, which points `XDG_CACHE_HOME` at an empty
 * per-worker directory, so `chromium` launches only when the process
 * environment also carries `PLAYWRIGHT_BROWSERS_PATH` (the real install,
 * `~/.cache/ms-playwright` by default). Branded Chrome is a system install
 * and never consults that directory.
 *
 * This module is a leaf on purpose: the `.mjs` capture script cannot load
 * workbench-e2e.ts (its `test.extend` needs a running Rstest worker), so both
 * import the selection from here instead of carrying their own copy.
 */
export const playwrightChannelVariable = 'AGENT_BUNDLE_PLAYWRIGHT_CHANNEL';

const selectLaunchOptions = (channel: string | undefined): LaunchOptions => {
  switch (channel) {
    case undefined:
    case '':
    case 'chrome':
      return { channel: 'chrome' };
    case 'chromium':
      return {};
    default:
      throw new Error(`${playwrightChannelVariable} must be "chrome" or "chromium", got ${JSON.stringify(channel)}.`);
  }
};

/** Shared `browserType.launch()` options for every Workbench browser suite; see {@link playwrightChannelVariable}. */
export const browserLaunchOptions: LaunchOptions = Object.freeze(selectLaunchOptions(process.env[playwrightChannelVariable]));
