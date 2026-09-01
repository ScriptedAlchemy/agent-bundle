---
"create-agent-bundle": patch
---

Verify every tar header checksum when inspecting a local `file:` framework or runtime tarball, so an archive that inflates but is corrupt fails the scaffold instead of being reported ready. Relative `file:` specs are now resolved against the new project directory — the same base npm uses for the emitted `package.json` — rather than the CLI's working directory.
