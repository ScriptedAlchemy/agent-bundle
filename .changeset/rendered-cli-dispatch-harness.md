---
"agent-bundle": minor
---

Exercise rendered CLI command routes through the public `cli-dispatch` test
harness. `invokeCli` now mirrors the generated executable's render session,
supports explicit TTY projection through `tty`, and exposes `cliNdjson` for
asserting ordered rendered event streams.
