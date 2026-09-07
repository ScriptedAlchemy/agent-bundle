---
"agent-bundle": patch
---

Add the `agent-bundle/install` entry so a published plugin can ship a package-bound installer bin without bundling the framework's installer source or parsing argv itself: `runInstallCli(argv, { from, name })` runs the `agent-bundle` CLI's own `install <host>`, `uninstall <host>`, and `doctor` commands — the same flags, receipts, replacement rules, `--plan`, data policy, `--json` output, and exit codes (`doctor` writes its report to stdout and exits 1 on an error finding; a failed `install`/`uninstall` writes one diagnostics JSON line to stderr) — with the bundle root pinned to the package that ships the bin (no `--from`). The entry also exports `installBundle`, `uninstallBundle`, `runDoctor`, `formatInstallResult`, `formatUninstallResult`, the new `formatDoctorReport`, and their option and result types. Fixes #724. (#730)
