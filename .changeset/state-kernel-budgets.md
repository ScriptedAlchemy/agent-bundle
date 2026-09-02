---
"@agent-bundle/runtime": minor
---

Add fail-closed size, time, and retention budgets to the optional Agent state
kernel. `defineState` now resolves configurable runtime policy defaults, and
the memory and SQLite drivers enforce identical typed `budget-exceeded`
semantics without changing reads or replay of committed history.
