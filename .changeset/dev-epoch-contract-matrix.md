---
"agent-bundle": patch
---

Gate live host and development-install epoch adoption on an opt-in, project-declared contract matrix (`dev.contracts`). Each published epoch runs the generated contract matrix through an epoch-pinned generated stdio session at the new `dev-epoch` proof level (`runDevEpochContractMatrix`); failing epochs stay inactive for live host MCP connections and `--install-host` installs while the last passing epoch keeps serving, and are reported on the `dev.contract.status` project event with `AB7210` (invalid declaration or fixture module) or `AB7211` (contract violations). `startDevServer().status()` and `/api/project/status` now carry a `hostAdoption` snapshot (`mode`, `adoptedEpochId`, latest `contracts` evaluation) that the Workbench Overview renders as **Host adoption**. A cold start whose initial build fails now seeds the restored last-good epoch through the same gate instead of leaving hosts without an epoch.
