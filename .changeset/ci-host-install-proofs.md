---
"agent-bundle": patch
---

Pin the Claude Code and Codex CLI versions the real-host install proofs run
against beside each adapter's schema provenance (`hostCli` in
`src/adapters/schemas/{claude,codex}/PROVENANCE.json`, kept equal to
`observedCliVersion`), and export the Codex adapter's declared
`codexInterfaceFields` so the host-install proofs can reject an undeclared
`interface` emission before comparing against their single pinned snapshot.
Repository CI now installs the pinned CLIs and runs the host-install, packed
host-install, and packed Claude plugin-validation proofs on every change,
signed out and without secrets. No runtime behavior changes.
