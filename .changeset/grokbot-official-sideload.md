---
"agent-bundle": patch
---

Sideload the plugin into Grok Bot's synced marketplace on `install grokbot` when Grok Bot agent-data is found: add the plugin folder and a `marketplace.json` entry to the active `scriptedalchemy/plugins` clone, and write a `.cache-complete` copy under `plugins/cache/scriptedalchemy-plugins`. Folders and entries the installer did not write are never touched. Every written path is recorded in the install receipt, and `uninstall grokbot` removes exactly those paths. Change or turn off the target with `--sideload-repo`, `--sideload-slug`, or `--no-sideload` (or `GROK_BOT_SIDELOAD_REPO`, `GROK_BOT_SIDELOAD_SLUG`, `GROK_BOT_SIDELOAD=0`). `doctor` reports the sideload state as AB7335. (#876)
