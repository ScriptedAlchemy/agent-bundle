---
"agent-bundle": minor
---

Refuse `agent-bundle uninstall claude|codex --force --purge-data --confirm-purge` with `AB7009` when no store receipt proves the bundle owns the install. Without a receipt, web-data and Claude's `plugins/data/<id>/` are no longer deleted. The refusal happens before any host verb runs, and `--plan` refuses the same way. `--force` without `--purge-data` still uninstalls through the host CLI and keeps the data. Remove unreceipted data by hand. (#853)
