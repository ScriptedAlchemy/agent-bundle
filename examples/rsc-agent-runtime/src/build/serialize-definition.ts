import { z } from 'zod';
import type { ZodType } from 'zod';

import { runtimeDefinition } from '../definition.js';
import type {
  RuntimeDefinition,
  SerializedRuntimeDefinition,
  SerializedRuntimeToolDefinition,
} from '../runtime/contracts.js';

const toMcpJsonSchema = (schema: ZodType): Record<string, unknown> => {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
};

export const serializeRuntimeDefinition = (
  definition: RuntimeDefinition = runtimeDefinition,
): SerializedRuntimeDefinition => ({
  nativeHooks: definition.nativeHooks.map((hook) => ({ ...hook })),
  resources: definition.resources.map((resource) => ({
    ...resource,
    _meta: {
      ...resource._meta,
      'ui.csp': {
        ...resource._meta['ui.csp'],
        connectDomains: [...resource._meta['ui.csp'].connectDomains],
        resourceDomains: [...resource._meta['ui.csp'].resourceDomains],
      },
    },
  })),
  tools: definition.tools.map(
    (tool): SerializedRuntimeToolDefinition => ({
      ...tool,
      _meta: {
        ...tool._meta,
        ui: tool._meta.ui === undefined ? undefined : { ...tool._meta.ui },
      },
      annotations: { ...tool.annotations },
      inputSchema: toMcpJsonSchema(tool.inputSchema),
      outputSchema: toMcpJsonSchema(tool.outputSchema),
    }),
  ),
});
