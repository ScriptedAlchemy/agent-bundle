---
"agent-bundle": minor
"create-agent-bundle": patch
---

Add the OpenCode V2 `opencode` target with native package output, `install opencode` / `uninstall opencode`, `dev --install-host opencode`, and `doctor --host opencode`, plus `AB6040`, `AB6041`, and `AB7336` diagnostics. Advance `artifactManifestVersion` to 7 for the OpenCode built-in projection; the artifact APIs reject v6 manifests, so rebuild existing artifacts with this version. (#896)
