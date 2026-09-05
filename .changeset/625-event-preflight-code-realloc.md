---
'agent-bundle': patch
---

Renumber the event-route diagnostics that landed with #618: the `preflight` gate export defect moves from `AB4840` to `AB4850`, and the `config.providers` required-provider declaration defect moves from `AB4841` to `AB4851`. `AB4840`–`AB4842` belong to the CLI surface projections of #596; suppressions or tooling that matched the old codes on an unreleased `main` must match `AB4850`/`AB4851` instead. (#625)
