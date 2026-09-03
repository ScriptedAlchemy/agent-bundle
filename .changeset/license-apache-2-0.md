---
"agent-bundle": patch
"@agent-bundle/runtime": patch
"create-agent-bundle": patch
---

License: Apache-2.0 (previously unspecified/MIT-declared); LICENSE and NOTICE
shipped in the tarball. Every package manifest now declares
`"license": "Apache-2.0"`, the build copies the repository LICENSE and NOTICE
into each publishable package, and `pnpm audit:release` fails if any
publishable tarball is missing either file or the license field.
