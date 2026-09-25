---
"agent-bundle": minor
---

Remove the legacy install readers from `install`, `uninstall`, `doctor`, and the emitted `install.mjs`: format-1 receipts (`agent-bundle-install-receipt/1`), receipt-less "legacy" adoption of a pre-receipt Cursor copy, the in-tree `<plugin root>/state` handling and its `--purge-data` removal, the compatibility receipt `stateRoot` field, and the `AB7317` unsupported-runtime report. A Cursor directory without a format-2 receipt naming the plugin is foreign: `install` refuses it with `AB7005` (with or without `--replace`), `uninstall` refuses it with `AB7007` (with or without `--force`), and Doctor reports it as `AB7321`; remove such a directory by hand and reinstall. An in-tree `state/` is an ordinary unowned entry that `uninstall` retains and lists, never purges. A runtime that rejects the status probe is a failed probe (`AB7318`). `AB7317`, `AB7329`, and `AB7332` are retired. (#841)
