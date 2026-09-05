---
"agent-bundle": patch
---

Make `uninstall --purge-data` remove the effective framework state root and make `doctor` report its source, existence, writability, `AB7316` permission failures, and `AB7332` retained pre-#640 state (#641).
