/**
 * The audiobook-curator application: runtime identity plus the operation
 * catalog. Structure — targets, the Skill, the CLI script, the MCP server —
 * lives in `agent-bundle.config.ts` and file conventions; the operations
 * themselves live in feature modules under `./operations/`, and this file
 * only merges their defaults.
 */
import { defineRscApplication } from '@agent-bundle/rsc-runtime/plugin';

import {
  audibleOperations,
  defaultAudibleOperations,
  type AudibleOperations,
} from './operations/audible.tsx';
import {
  defaultDiscoveryOperations,
  discoveryOperations,
  type DiscoveryOperations,
} from './operations/discovery.tsx';
import {
  defaultEvidenceOperations,
  evidenceOperations,
  type EvidenceOperations,
} from './operations/evidence.tsx';
import {
  defaultMediaMutationOperations,
  mediaMutationOperations,
  type MediaMutationOperations,
} from './operations/media-mutation.tsx';
import {
  defaultOutputOperations,
  outputOperations,
  type OutputOperations,
} from './operations/output.tsx';

/**
 * Injection surface for tests and embedders: every operation executor can be
 * replaced while the CLI/MCP projections and schemas stay identical.
 */
export type AudiobookCuratorOperations =
  & AudibleOperations
  & DiscoveryOperations
  & EvidenceOperations
  & MediaMutationOperations
  & OutputOperations;

const operationDefinitions = (operations: Required<AudiobookCuratorOperations>) => Object.freeze([
  ...evidenceOperations(operations),
  ...mediaMutationOperations(operations),
  ...audibleOperations(operations),
  ...discoveryOperations(operations),
  ...outputOperations(operations),
]);

export const createAudiobookCuratorApplication = (
  options: { readonly operations?: AudiobookCuratorOperations } = {},
) => defineRscApplication({
  description: 'Complete plan-first audiobook inventory, matching, conversion, repair, and integrity audit.',
  name: 'audiobook-curator',
  operations: operationDefinitions({
    ...defaultAudibleOperations,
    ...defaultDiscoveryOperations,
    ...defaultEvidenceOperations,
    ...defaultMediaMutationOperations,
    ...defaultOutputOperations,
    ...options.operations,
  }),
  version: '1.0.0',
});

export const audiobookCuratorApplication = createAudiobookCuratorApplication();
