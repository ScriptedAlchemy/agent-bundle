---
"agent-bundle": patch
---

`install grokbot` now also sideloads the plugin into Grok Bot's synced marketplace when Grok Bot agent-data is found: it adds the plugin folder and a `marketplace.json` entry to the active `scriptedalchemy/plugins` clone and writes a `.cache-complete` copy under `plugins/cache/scriptedalchemy-plugins`. It never touches folders or entries it did not write, records every written path in the install receipt, and `uninstall grokbot` removes exactly those paths. Use `--sideload-repo`, `--sideload-slug`, or `--no-sideload` (or `GROK_BOT_SIDELOAD_REPO`, `GROK_BOT_SIDELOAD_SLUG`, `GROK_BOT_SIDELOAD=0`) to change or turn off the target. `doctor` reports the sideload state as AB7335. (#876)
