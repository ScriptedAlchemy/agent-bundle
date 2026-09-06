# Claude live session proofs — 2026-09-03

The three Claude proofs CI cannot run (they need a signed-in Claude Code) were
run by hand against Claude Code 2.1.257 on this machine, the same day the
live host-lineage capture replaced the scripted stand-in
(`docs/audits/2026-09-03-host-lineage-matrix.md` §8). This note records how
the isolated home was authenticated, exactly what each proof asserted, and
what failed. Raw logs stayed under `/tmp/claude-recapture/`; nothing from them
is reproduced here beyond counts, codes, and field names.

## Authentication: isolated home, sign-in seeded outside the harness

- The real `~/.claude` was opened **read-only**. Its `.credentials.json`
  (interactive OAuth session) had expired and could not be refreshed:
  `claude auth status` on the real home reported `loggedIn: false`, and a
  turn in an isolated home seeded with the harness's byte-for-byte copy failed
  with `Failed to authenticate: OAuth session expired and could not be
  refreshed`. Because `claude auth status` against the operator's normal
  configuration already reported `loggedIn: false`, the documented fallback
  (normal configuration, temporary project directory) was not available
  either; no turn was run against the real home.
- The operator's long-lived `claude setup-token` token was still valid. The
  isolated home's `.claude/.credentials.json` was therefore re-seeded with
  that token by a **one-off local step outside the checked-in harness** (an
  uncommitted local edit of `probe:install` that wrote the token into the
  isolated file and never logged its value; discarded afterwards). No code
  that reads or copies sign-in state was added to `examples/host-test` or to
  the test support, which still only copy `.credentials.json` byte-for-byte.
  `claude auth status` in that home: `loggedIn: true`, `authMethod:
  claude.ai`, `apiProvider: firstParty`, `subscriptionType: max`.
- The proofs below ran with `HOME=/tmp/claude-recapture/proof-home`, a
  directory holding only that `.claude/.credentials.json` and the probe's
  onboarding `.claude.json`. `CLAUDE_CONFIG_DIR` was unset so the harnesses
  resolved `$HOME/.claude` exactly as they would on a developer machine. The
  real `~/.claude/.credentials.json`, `~/.claude/settings.json`,
  `~/.claude/plugins/installed_plugins.json`, and `~/.claude.json` mtimes were
  unchanged after every run (05:34, 08:12, 08:12, and 08:23 UTC respectively,
  all earlier than the first isolated turn of the day at 16:55 UTC). The
  isolated home was removed after the runs.
- `packedNativeEnvironment` drops `NODE_PATH`, the alternate-provider
  variables, and any name that (case-insensitively, ignoring separators)
  contains `apikey`, `apitoken`, `authtoken`, `accesstoken`, `authorization`,
  `credential`, `password`, `secret`, or `token` (`credentialEnvironmentKey`
  in `packages/agent-bundle/tests/support/packed-native-smoke.ts`). Generic
  names such as `AWS_ACCESS_KEY_ID` are not filtered. Because
  `CLAUDE_CODE_OAUTH_TOKEN` matches `token`, an environment transplant would
  not reach the host; the on-disk credentials file is the only route these
  proofs can authenticate through.

## Results

| Proof | Command (as run) | Result | Assertions that held | Notes |
| --- | --- | --- | --- | --- |
| Host-install session token proof | `HOME=<isolated> pnpm test:host-install:session:claude` (= `AGENT_BUNDLE_HOST_INSTALL_CLAUDE_SESSION=1`) | **pass** — 2/2 tests, 0 skipped (`resolves the Claude arguments, plugin-root, and skill-root tokens in a real session` ran, not skipped) | `claudeVersion` matches `^\d+\.\d+\.\d+$` (2.1.257); `invocation.mode: 'inline --plugin-dir session'`, `model: 'claude-sonnet-4-5'`, `attempts ≤ 2`; markers `arguments = CLAUDE_SESSION_ARGUMENT`, `pluginRoot: '.'`, `skillRoot: 'skills/token-probe'`; `resolved.pluginRoot` and `resolved.skillRoot` are absolute paths that exist and equal the loaded bundle root / its `skills/token-probe`; `normalHome.settingsAndPlugins: 'unchanged'`, `normalHome.sessionBookkeeping: 'rewritten by Claude Code on every real turn'`; the report matches no credential, home-path, or stdout/stderr pattern | Ran twice (before and after rebasing onto `origin/main` at #434); both passed |
| Packed native Eval smoke | `HOME=<isolated> pnpm test:packed:native:claude` (= `AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE=1`) | **pass after two fixes** — 8/8 tests, 0 skipped; `runs opted-in authored Eval hosts through one production-only packed installation` ran the Claude Eval (`packed-native-claude`, `claude-sonnet-4-5`, 1 trial, `pass: 1, fail: 0, inconclusive: 0`, `skill-activation` evidence `observed`, `exit-code` 0) | `report.package = { externalBinary: true, productionOnly: true, tarballs: 1 }`; `hosts = ['claude']`, every host `status: 'passed'`; the report matches no `OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|authorization|sk-…|/home/|/Users/|prompt|response|stdout|stderr` | See "Defects" 1 and 2: the script as shipped failed before any host ran, and the harness then mis-reported a passing Eval as `failed` |
| Native Claude contract smoke | `HOME=<isolated> AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE=1 rstest packages/agent-bundle/tests/native-claude-contract.test.ts` | **fail** — 17/18; `runs the checked-in candidate with the existing signed-in Claude subscription and writes redacted evidence` got `status: 'harness-failure'`, expected `'passed'` | Everything the smoke itself measures held: `authentication.status: 'subscription-session'`, `version: '2.1.257'`, `validation.exitCode: 0`, `stream.activationEvidence: 'observed'`, `stream.authSource: 'non-environment'`, `stream.plugins: ['agent-bundle-native-smoke']`, `errorEnvelopes: []`, a `result`/`success` envelope, `stderr.present: false` | Sole diagnostic: `claude-native.normal-home.changed`. See "Defects" 3 |

## Defects revealed

1. **`pnpm test:packed:native:claude|codex` could not pack under pnpm** (fixed
   here). The scripts ran `pnpm build && … pnpm test:packed:native`, so the
   harness's `npm_execpath` was pnpm's `pnpm.mjs`. `pnpm pack --json` prints
   the bare entry `{filename, files, name, version}`, which
   `packOutputFromJson` read as a four-entry package-keyed object (`npm pack
   --json returned 4 entries; expected exactly one`; after #432's by-name
   selection, `0 entries named "agent-bundle"`), and `pnpm install --omit=dev
   --no-audit --no-fund <tarball>` is rejected (`Unknown options: 'omit',
   'audit', 'fund'`). `scripts/run-packed-native-smoke.mjs`, which already
   existed for this purpose and drives `npm run build` + `npm run
   test:packed:native`, is now what both scripts call. The
   `native-host-smoke.yml` workflow commands are unchanged.
2. **The packed smoke guarded `.claude.json` across a real turn** (fixed
   here). `runPackedNativeSmoke` wrapped the Claude Eval in
   `normalClaudeHomeUnchanged`, whose digest includes `$HOME/.claude.json`.
   Claude Code 2.1.257 rewrites that file on every signed-in turn (observed:
   `cachedGrowthBookFeatures*`, `cachedExperiment*`, `firstStartTime`,
   `firstStartVersion`, `machineID`, `userID`, `migrationVersion`, migration
   flags, `seenNotifications`, `pluginUsage`, `skillUsage`, … appear or move
   even with `--no-session-persistence`), so a passing Eval (`pass: 1`) was
   reported as `status: 'failed'`. The Claude leg now uses
   `normalClaudeSettingsAndPluginsUnchanged` — the same guard the
   host-install session proofs adopted for the same reason — and reports
   `normalHome: 'settings-and-plugins-unchanged'`; `packed-native-smoke.test.ts`
   gained a unit test that a `.claude.json` rewrite passes while a
   `settings.json` or `plugins/` change fails.
3. **`runNativeClaudeSmoke` (then product code at
   `packages/agent-bundle/src/host-contracts/native-claude-contract.ts`, since moved to `packages/agent-bundle/tests/support/native-claude-smoke.ts`) has
   the same guard** and therefore cannot pass on Claude Code 2.1.257: its
   `snapshotClaudeNormalHome` digests `.claude.json` (`claudeJson`) beside
   `config.json`, `settings.local.json`, `plugins/`, and `settings.json`, and
   any difference yields `claude-native.normal-home.changed` →
   `harness-failure`. The smoke's own evidence shows the run succeeded (table
   above). **Not fixed in this change**: the fix drops `claudeJson` from
   `sameClaudeNormalHome` (or compares it with the host's bookkeeping keys
   removed), and the existing test `protects the default sibling Claude state
   file without retaining its opaque contents`
   (`native-claude-contract.test.ts`) asserts the opposite and must change
   with it. That test file is owned by the concurrent test-determinism lane
   (#432 landed its home-directory injection while this note was written), so
   the change is deferred to a follow-up rather than edited here: filed as
   [#439](https://github.com/ScriptedAlchemy/agent-bundle/issues/439). Until then
   the `native-host-smoke` workflow's Claude source leg will report
   `harness-failure` on every run against 2.1.257.

## Re-run later the same day: unmodified harness, Claude Code 2.1.259

After the operator signed in again, `probe:install claude` — the checked-in
harness, byte-for-byte copy of `~/.claude/.credentials.json`, no local edits —
produced a signed-in isolated home at `/tmp/host-test/claude-home`
(`claude auth status` → `loggedIn: true`, `authMethod: claude.ai`). The three
proofs were re-run with `HOME=/tmp/host-test/claude-home` (raw logs under
`/tmp/claude-live/orch/`), right after that home had hosted the four-turn
orchestration capture (`docs/audits/2026-09-03-host-lineage-matrix.md`,
"orchestration run"):

| Proof | Result | Assertions that held |
| --- | --- | --- |
| `pnpm test:host-install:session:claude` | **pass** — 2/2, 0 skipped | the same assertions as above against Claude Code 2.1.259 |
| `pnpm test:packed:native:claude` | **pass** — 8/8, 0 skipped, no fix needed this time (defects 1–2 are merged) | `hosts = ['claude']`, `status: 'passed'`, Eval `pass: 1, fail: 0` |
| `AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE=1 rstest …/native-claude-contract.test.ts` | **fail** — 17/18, `status: 'harness-failure'` | everything measured held again (`authentication.status: 'subscription-session'`, `version: '2.1.259'`, `validation.exitCode: 0`, `stream.activationEvidence: 'observed'`, `stream.authSource: 'non-environment'`, `stream.plugins: ['agent-bundle-native-smoke']`, `errorEnvelopes: []`, one `result`/`success`, `stderr.present: false`); sole diagnostic `claude-native.normal-home.changed` — defect 3, still open as [#439](https://github.com/ScriptedAlchemy/agent-bundle/issues/439), reproduced on 2.1.259 |

The real `~/.claude` was again never written by any of these runs.

## Cost and footprint

The two lineage captures reported `total_cost_usd` of roughly $0.44 and
$0.36; the session, packed-Eval (repeated while diagnosing defects 1–2), and
contract turns were each cheaper, all on the operator's Max subscription. Every
isolated home used here was under `/tmp/claude-recapture/` or
`/tmp/host-test/` and held a copy of the long-lived token; `probe:uninstall
claude` removed the probe's home (`/tmp/host-test/claude-home` and
`/tmp/host-test/claude-workspace` are gone; the captures under
`/tmp/host-test/claude/` remain) and `rm -rf /tmp/claude-recapture/proof-home`
removed the proofs' home. The 2.1.259 orchestration capture cost about $1.23
across its four turns (`total_cost_usd` 0.79 + 0.14 + 0.24 + 0.07); its
isolated home was removed by `probe:uninstall claude` after the re-run above.
