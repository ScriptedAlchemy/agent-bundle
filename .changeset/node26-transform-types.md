---
"agent-bundle": patch
---

Run plain `.ts` scripts through `runScript` (`agent-bundle/test`) on Node 26: the child process gets `--experimental-transform-types` only where the running Node accepts it (Node 22 and 24) and `--strip-types` on Node 26, which removed the transform flag and only strips types; the flag is always named on the command line, so an inherited `NODE_OPTIONS=--no-strip-types` cannot switch TypeScript loading off. Previously every plain-script dispatch on Node 26 exited with code 9 (`node: bad option: --experimental-transform-types`) before the script ran; TypeScript-only syntax such as `enum` in a plain script now fails on Node 26 exactly as it does under `node file.ts`. (#554)
