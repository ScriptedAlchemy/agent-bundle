---
"agent-bundle": patch
---

Sideload the plugin into Grok Bot's synced marketplace on `install grokbot` when Grok Bot agent-data is found: add the plugin folder and a `marketplace.json` entry to the one active `scriptedalchemy/plugins` clone, and write a `.cache-complete` copy under `plugins/cache/scriptedalchemy-plugins`. Folders and entries the installer did not write are never touched, and every write is atomic. Every written path is recorded in the install receipt, and `uninstall grokbot` removes exactly those paths. Change or turn off the target with `--sideload-repo`, `--sideload-slug`, or `--no-sideload` (or `GROK_BOT_SIDELOAD_REPO`, `GROK_BOT_SIDELOAD_SLUG`, `GROK_BOT_SIDELOAD=0`). `GROK_BOT_SIDELOAD_MARKETPLACE` is still read but must name one repository. The next install or uninstall retires the first sideload's `agent-bundle/sideload/<plugin>.json` record under `~/.grokbot` (or `GROK_BOT_HOME`). `doctor` reports the sideload state as AB7335. (#876)
