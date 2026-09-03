---
"agent-bundle": patch
---

Link the package README to the hosted documentation site so `npm` readers can find the full guide, configuration, host, event, notice, and diagnostics references. The pinned Cursor and portable capability tables now record Cursor's `.cursor-plugin/marketplace.json` path and the portable `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` tokens, so the generated host matrix matches what the adapters emit. `agent-bundle build --help` and `prepack --help` now state the real `--output` default, `artifact`, instead of `dist`. (#384)
