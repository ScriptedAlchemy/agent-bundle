---
"agent-bundle": patch
---

Add `--mode local|marketplace` to `agent-bundle install cursor`, the generated installer bin, and the emitted `install.mjs`: marketplace mode stages a committed local `.cursor-plugin/marketplace.json` repository under `~/.cursor/agent-bundle/marketplaces/<name>` and prints the Cursor Customize import step, while local mode keeps the safe copy into `~/.cursor/plugins/local/<name>`. Doctor now proves Cursor hook registration from the plugin manifest (`AB7322`), warns about duplicate `~/.cursor/hooks.json` delivery (`AB7323`), and tracks staged marketplaces to imported (`AB7324`). Documents that plugin-scoped hooks fire without user-level registration, closing #407 (#414).
