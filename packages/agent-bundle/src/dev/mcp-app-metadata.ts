import type { McpAppJsonValue, McpAppToolDefinition } from './mcp-app-binding-service.ts';

export interface McpAppResultInspection {
  readonly appVisible: McpAppJsonValue;
  readonly isError: boolean;
  readonly modelVisible: McpAppJsonValue;
}

export interface McpAppMetadataInspection {
  readonly raw: Readonly<Record<string, McpAppJsonValue>>;
  readonly standard: Readonly<{ readonly ui?: McpAppJsonValue }>;
  readonly extensions: Readonly<{
    readonly openai: Readonly<Record<string, McpAppJsonValue>>;
    readonly claude: Readonly<Record<string, McpAppJsonValue>>;
  }>;
  readonly provenance: Readonly<Record<string, 'standard' | 'openai-extension' | 'claude-extension' | 'unclassified'>>;
}

export interface McpAppResourceMetadataInspection {
  readonly merged: McpAppMetadataInspection;
  readonly provenance: Readonly<Record<string, 'listed' | 'read' | 'both-identical' | 'read-overrode-listed'>>;
  readonly warnings: readonly string[];
}

export interface McpAppResourceReference {
  readonly provenance: 'modern' | 'legacy' | 'modern-overrode-legacy';
  readonly uri: string;
  readonly warnings: readonly string[];
}

type JsonRecord = Readonly<Record<string, McpAppJsonValue>>;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const ownData = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new TypeError('MCP App values must be finite JSON values without accessors.');
  }
  return descriptor.value;
};

const isDenseArray = (value: readonly unknown[]): boolean => {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Object.keys(value);
  if (keys.length !== value.length) return false;
  return keys.every((key, index) => key === String(index));
};

const cloneFiniteJson = (value: unknown, seen = new WeakSet<object>()): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('MCP App values must be finite JSON values.');
  }
  if (Array.isArray(value)) {
    if (!isDenseArray(value) || seen.has(value)) throw new TypeError('MCP App values must be finite JSON values.');
    seen.add(value);
    try {
      return Object.freeze(value.map((item, index) => cloneFiniteJson(ownData(value, String(index)), seen)));
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainRecord(value) || seen.has(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('MCP App values must be finite JSON values.');
  }
  seen.add(value);
  try {
    const copied: Record<string, McpAppJsonValue> = {};
    for (const key of Object.keys(value).sort()) copied[key] = cloneFiniteJson(ownData(value, key), seen);
    return Object.freeze(copied);
  } finally {
    seen.delete(value);
  }
};

const jsonRecord = (value: unknown, label: string): JsonRecord => {
  const cloned = cloneFiniteJson(value);
  if (!isPlainRecord(cloned)) throw new TypeError(`${label} must be a finite JSON object.`);
  return cloned;
};

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

const uiUri = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'ui:' && parsed.hostname.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const deepEqual = (left: McpAppJsonValue, right: McpAppJsonValue): boolean => JSON.stringify(left) === JSON.stringify(right);

const metadataRecord = (value: unknown): JsonRecord => {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value)) return jsonRecord(value, 'MCP App metadata');
  if (hasOwn(value, '_meta')) {
    const metadata = ownData(value, '_meta');
    return metadata === undefined ? Object.freeze({}) : jsonRecord(metadata, 'MCP App metadata');
  }
  return jsonRecord(value, 'MCP App metadata');
};

const isVendorKey = (key: string, namespace: 'openai' | 'claude'): boolean => key === namespace || key.startsWith(`${namespace}/`);

/** Validates, detaches, sorts, and recursively freezes a protocol JSON value. */
export const cloneMcpAppFiniteJson = (value: unknown, label = 'MCP App value'): McpAppJsonValue => {
  try {
    return cloneFiniteJson(value);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('finite JSON')) throw error;
    throw new TypeError(`${label} must be a finite JSON value.`, { cause: error });
  }
};

export const inspectMcpAppMetadata = (value: unknown): McpAppMetadataInspection => {
  const raw = metadataRecord(value);
  const standard: { ui?: McpAppJsonValue } = {};
  const openai: Record<string, McpAppJsonValue> = {};
  const claude: Record<string, McpAppJsonValue> = {};
  const provenance: Record<string, 'standard' | 'openai-extension' | 'claude-extension' | 'unclassified'> = {};
  for (const [key, child] of Object.entries(raw)) {
    if (key === 'ui') {
      standard.ui = child;
      provenance[key] = 'standard';
    } else if (isVendorKey(key, 'openai')) {
      openai[key] = child;
      provenance[key] = 'openai-extension';
    } else if (isVendorKey(key, 'claude')) {
      claude[key] = child;
      provenance[key] = 'claude-extension';
    } else {
      provenance[key] = 'unclassified';
    }
  }
  return Object.freeze({
    extensions: Object.freeze({ claude: Object.freeze(claude), openai: Object.freeze(openai) }),
    provenance: Object.freeze(provenance),
    raw,
    standard: Object.freeze(standard),
  });
};

export const mergeMcpAppResourceMetadata = (listed: unknown, read: unknown): McpAppResourceMetadataInspection => {
  const listedMetadata = metadataRecord(listed);
  const readMetadata = metadataRecord(read);
  const merged: Record<string, McpAppJsonValue> = {};
  const provenance: Record<string, 'listed' | 'read' | 'both-identical' | 'read-overrode-listed'> = {};
  const keys = new Set([...Object.keys(listedMetadata), ...Object.keys(readMetadata)]);
  for (const key of [...keys].sort()) {
    const listedValue = listedMetadata[key];
    const readValue = readMetadata[key];
    if (listedValue === undefined) {
      merged[key] = readValue!;
      provenance[key] = 'read';
    } else if (readValue === undefined) {
      merged[key] = listedValue;
      provenance[key] = 'listed';
    } else if (deepEqual(listedValue, readValue)) {
      merged[key] = readValue;
      provenance[key] = 'both-identical';
    } else {
      merged[key] = readValue;
      provenance[key] = 'read-overrode-listed';
    }
  }
  return Object.freeze({
    merged: inspectMcpAppMetadata(merged),
    provenance: Object.freeze(provenance),
    warnings: Object.freeze([]),
  });
};

export const selectMcpAppResourceReference = (metadata: unknown): McpAppResourceReference | undefined => {
  const raw = metadataRecord(metadata);
  const ui = raw.ui;
  const modern = isPlainRecord(ui) ? uiUri(ui.resourceUri) : undefined;
  const legacy = uiUri(raw['ui/resourceUri']);
  if (modern === undefined && legacy === undefined) return undefined;
  if (modern === undefined) return Object.freeze({ provenance: 'legacy', uri: legacy!, warnings: Object.freeze([]) });
  if (legacy === undefined || legacy === modern) return Object.freeze({ provenance: 'modern', uri: modern, warnings: Object.freeze([]) });
  return Object.freeze({
    provenance: 'modern-overrode-legacy',
    uri: modern,
    warnings: Object.freeze(['Nested standard ui.resourceUri overrides conflicting legacy resource metadata.']),
  });
};

const validContent = (value: McpAppJsonValue): value is readonly McpAppJsonValue[] =>
  Array.isArray(value) && value.every((block) => isPlainRecord(block) && typeof block.type === 'string' && block.type.length > 0);

export const projectMcpAppResult = (value: unknown): McpAppResultInspection => {
  const appVisible = jsonRecord(value, 'MCP CallToolResult');
  if (!hasOwn(appVisible, 'content') || !validContent(appVisible.content)) {
    throw new TypeError('MCP CallToolResult must contain a finite JSON content array.');
  }
  if (hasOwn(appVisible, 'isError') && typeof appVisible.isError !== 'boolean') {
    throw new TypeError('MCP CallToolResult isError must be a boolean.');
  }
  const modelVisible: Record<string, McpAppJsonValue> = { content: appVisible.content };
  if (hasOwn(appVisible, 'structuredContent')) modelVisible.structuredContent = appVisible.structuredContent!;
  return Object.freeze({
    appVisible,
    isError: appVisible.isError === true,
    modelVisible: Object.freeze(modelVisible),
  });
};

/** Only tool metadata controls tool visibility; resources retain ui.visibility as ordinary metadata. */
export const isMcpAppToolVisible = (tool: unknown): boolean => {
  if (!isPlainRecord(tool) || typeof tool.name !== 'string' || tool.name.length === 0) return false;
  const metadata = tool._meta;
  if (!isPlainRecord(metadata) || !isPlainRecord(metadata.ui) || !hasOwn(metadata.ui, 'visibility')) return true;
  const visibility = metadata.ui.visibility;
  return Array.isArray(visibility) && visibility.every((value) => typeof value === 'string') && visibility.includes('app');
};

export type { McpAppJsonValue, McpAppToolDefinition };
