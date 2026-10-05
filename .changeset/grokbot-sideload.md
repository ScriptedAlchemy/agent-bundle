---
"agent-bundle": minor
---

`install grokbot` now also sideloads the plugin into a marketplace snapshot Grok Bot already syncs: on a Grok Bot computer it mirrors the Cursor projection into `<agent-data>/plugins/marketplaces/github.com/<owner>/<repo>/<commit>/<plugin>/`, lists it in that snapshot's `.cursor-plugin/marketplace.json`, and writes `<agent-data>/plugins/cache/<owner>-<repo>/<plugin>/<commit>/` with `.cache-complete`, the same layout as official plugins. The target is the bundle repository owner's marketplace (or `GROK_BOT_SIDELOAD_MARKETPLACE=owner/repo`); plugins the hosted marketplace already ships are left alone, `GROK_BOT_SIDELOAD=0` disables it, and `uninstall grokbot` removes exactly what was sideloaded.
