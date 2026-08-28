import { NATIVE_HOSTS } from '../host-contracts/native-hosts.ts';

/** Stable harness selector ids shared by the CLI, Agent API, and Workbench. */
export const EVAL_HARNESS_NAMES = Object.freeze([...NATIVE_HOSTS, 'deterministic'] as const);

export type EvalHarnessName = (typeof EVAL_HARNESS_NAMES)[number];
