---
"agent-bundle": patch
---

Add the `agent-bundle/install` entry so a published plugin can ship a package-bound installer bin without bundling the framework's installer source or parsing argv itself: `runInstallCli(argv, { from, name })` runs the `agent-bundle` CLI's own `install <host>`, `uninstall <host>`, and `doctor` commands — the same flags, receipts, replacement rules, `--plan`, data policy, `--json` output, and exit codes — with the bundle root pinned to the package that ships the bin (no `--from`, no artifact-root probing). The entry also exports `installBundle`, `uninstallBundle`, `runDoctor`, `formatInstallResult`, `formatUninstallResult`, the new `formatDoctorReport`, and their option and result types. The three commands are declared once and shared with the `agent-bundle` CLI. Proven from a packed consumer whose source and `node_modules` are deleted before its bin installs, replaces, plans, and uninstalls a Cursor copy (`packed-install-bin`). Fixes #724. (#730)
