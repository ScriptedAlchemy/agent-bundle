---
'agent-bundle': patch
---

Add a `grokbot` install host. `agent-bundle install grokbot` (and `<bundle>-install install grokbot` from package-bound installer bins) stages the bundle's Cursor projection as a committed marketplace repository under `~/.grokbot/agent-bundle/marketplaces/<name>` with a store receipt, and prints the remaining Grok Bot steps: host the repository, add it as a plugin marketplace, and install the plugin from Grok Bot's Marketplace, which assigns the plugin id server-side. `agent-bundle doctor --host grokbot` reports the plugin id and installed commit from the Grok Bot computer's plugin cache (`AB7334`), and `agent-bundle uninstall grokbot` removes the staging and receipt and names the plugin id to uninstall in Grok Bot. (#864)
