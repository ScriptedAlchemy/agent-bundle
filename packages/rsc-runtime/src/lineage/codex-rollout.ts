import { open } from 'node:fs/promises';

/**
 * The head of a Codex rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`)
 * is a `session_meta` line the host writes when the thread is created. For a
 * thread spawned by `spawn_agent` it names the spawning thread and the depth
 * (`source.subagent.thread_spawn`), which the hook payloads omit (#423). Hooks
 * fired inside a subagent name that rollout in `transcript_path`
 * (`agent_transcript_path` on `SubagentStop`), so the lineage the payload
 * lacks is read from the file the same payload points at. Observed shape,
 * cli 0.130.0 → 0.152.0 (8,049 thread-spawn rollouts, 2026-09-03):
 * `payload.id` (thread), `payload.session_id` (root), `payload.thread_source`
 * (`user` | `subagent`), `payload.source.subagent.thread_spawn.{parent_thread_id, depth, agent_path?}`.
 */
export interface CodexRolloutMeta {
  /** `source.subagent.thread_spawn.agent_path`, e.g. `/root/host_probe/nested_probe`; absent on some builds. */
  readonly agentPath?: string;
  /** Spawn depth the host recorded: 1 for a child of the root. Absent on a root. */
  readonly depth?: number;
  /** The spawning thread. Absent on a root. */
  readonly parent?: string;
  /** The root thread (`session_id`); equals `thread` on a root. */
  readonly root?: string;
  /** Which subagent mechanism produced the thread (`thread_spawn`, `review`, …); absent on a root. */
  readonly subagentKind?: string;
  /** `payload.id`: the thread the rollout belongs to. */
  readonly thread: string;
}

/** Longest `session_meta` line the reader accepts (observed 13–43 KiB; `base_instructions` is inlined). */
export const CODEX_ROLLOUT_HEAD_BYTES = 1_048_576;

const ROLLOUT_BASENAME = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/iu;

/** The thread id a rollout path encodes (`rollout-<timestamp>-<thread>.jsonl`), or `undefined` for any other path. */
export const codexThreadFromRolloutPath = (path: string | undefined): string | undefined => {
  if (path === undefined) return undefined;
  const match = ROLLOUT_BASENAME.exec(path);
  return match?.[1]?.toLowerCase();
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** Parses the first line of a rollout; `undefined` for anything that is not a `session_meta` naming its thread. */
export const parseCodexRolloutMeta = (head: string): CodexRolloutMeta | undefined => {
  const newline = head.indexOf('\n');
  const line = (newline === -1 ? head : head.slice(0, newline)).trim();
  if (line === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const item = record(parsed);
  if (item?.['type'] !== 'session_meta') return undefined;
  const payload = record(item['payload']);
  const thread = text(payload?.['id']);
  if (payload === undefined || thread === undefined) return undefined;
  const root = text(payload['session_id']);
  const source = record(payload['source']);
  // A string `source` (`exec`, `cli`, `vscode`) is a root. `{ subagent: { thread_spawn: {…} } }`
  // is a spawned thread; `{ subagent: { other: "…" } }` or `{ subagent: "review" }` are
  // host-internal threads that have no spawn lineage.
  const subagent = record(source?.['subagent']);
  if (subagent === undefined) {
    const kind = text(source?.['subagent']);
    return { ...(kind === undefined ? {} : { subagentKind: kind }), ...(root === undefined ? {} : { root }), thread };
  }
  const [subagentKind] = Object.keys(subagent);
  const spawn = record(subagent['thread_spawn']);
  const parent = text(spawn?.['parent_thread_id']) ?? text(payload['parent_thread_id']);
  const rawDepth = spawn?.['depth'];
  const depth = typeof rawDepth === 'number' && Number.isInteger(rawDepth) && rawDepth > 0 ? rawDepth : undefined;
  const agentPath = text(spawn?.['agent_path']) ?? text(payload['agent_path']);
  return {
    ...(agentPath === undefined ? {} : { agentPath }),
    ...(depth === undefined ? {} : { depth }),
    ...(parent === undefined ? {} : { parent }),
    ...(root === undefined ? {} : { root }),
    ...(subagentKind === undefined ? {} : { subagentKind }),
    thread,
  };
};

/** Reads a file head for the parser; the default reader stops at the first newline or the byte cap. */
export type CodexRolloutReader = (path: string) => Promise<string | undefined>;

export const readCodexRolloutHead: CodexRolloutReader = async (path) => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.allocUnsafe(CODEX_ROLLOUT_HEAD_BYTES);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      const newline = buffer.subarray(filled, filled + bytesRead).indexOf(0x0a);
      if (newline !== -1) {
        filled += newline;
        break;
      }
      filled += bytesRead;
    }
    return buffer.subarray(0, filled).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * The spawn lineage of `thread` as its own rollout records it, or `undefined`
 * when the file is unreadable, belongs to a different thread, or describes a
 * thread the host did not spawn (a root, or a review/compact helper).
 */
export const readCodexSpawnLineage = async (
  path: string | undefined,
  thread: string,
  read: CodexRolloutReader = readCodexRolloutHead,
): Promise<(CodexRolloutMeta & { readonly depth: number; readonly parent: string }) | undefined> => {
  if (path === undefined) return undefined;
  const head = await read(path);
  if (head === undefined) return undefined;
  const meta = parseCodexRolloutMeta(head);
  if (meta === undefined || meta.thread !== thread || meta.parent === undefined || meta.depth === undefined) return undefined;
  return { ...meta, depth: meta.depth, parent: meta.parent };
};
