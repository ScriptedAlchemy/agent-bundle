---
"agent-bundle": patch
---

Cut artifact validation time in `agent-bundle build` and `agent-bundle validate --artifact` without dropping a check: modules the framework compiled (manifest kind `bundle`) are no longer re-parsed in full with `acorn` to prove they are JavaScript — the ESM lexer that drives the import-graph walk is their only syntax pass, while copied and generated modules the framework did not compile keep the full parse — and each module's imports are read once per process by content digest, so the post-compile self-containment check and the two validation passes of one build share one lex. `AB6005` codes and messages are unchanged; `validate --artifact` results are identical for every emitted artifact. `examples/host-test`: build 40 s → 12.5 s, `validate --artifact` 17 s → 3.6 s; `examples/audiobook-curator`: build 12.7 s → 6.8 s. (#521)
