---
"agent-bundle": patch
---

Run plain `.ts` scripts through `runScript` (`agent-bundle/test`) on Node 26: the child process gets `--experimental-transform-types` only where the running Node accepts it (Node 22 and 24) and no TypeScript flag on Node 26, which removed that flag and strips types by default. Previously every plain-script dispatch on Node 26 exited with code 9 (`node: bad option: --experimental-transform-types`) before the script ran; TypeScript-only syntax such as `enum` in a plain script now fails on Node 26 exactly as it does under `node file.ts`. (#PR)
