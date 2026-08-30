/**
 * The audiobook-curator application: one `defineRscAgentBundle` tree that
 * composes the Skill, the CLI Script, the MCP server, and the operation
 * catalog. The operations themselves live in feature modules under
 * `./operations/`; this file only merges their defaults and declares the
 * bundle.
 */
import {
  AgentBundle,
  McpServer,
  Operation,
  Script,
  Skill,
  defineRscAgentBundle,
} from '@agent-bundle/rsc-runtime/plugin';
import React from 'react';

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
) => {
  const definitions = operationDefinitions({
    ...defaultAudibleOperations,
    ...defaultDiscoveryOperations,
    ...defaultEvidenceOperations,
    ...defaultMediaMutationOperations,
    ...defaultOutputOperations,
    ...options.operations,
  });
  return defineRscAgentBundle(
    <AgentBundle
      description="Complete plan-first audiobook inventory, matching, conversion, repair, and integrity audit."
      marketplace
      name="audiobook-curator"
      node="22.19.0"
      targets={['claude', 'codex']}
      version="1.0.0"
    >
      <Skill source="./skills/curate-audiobooks" />
      <Script entry="./src/cli-entry.ts" name="audiobook-curator" />
      <McpServer entry="./src/mcp-server.ts" name="curator" />
      {definitions.map((definition) => <Operation definition={definition} key={definition.id} />)}
    </AgentBundle>,
  );
};

export const audiobookCuratorApplication = createAudiobookCuratorApplication();
