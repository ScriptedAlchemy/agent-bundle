import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Reports the plugin root and durable-state anchor this route observes.',
  title: 'Plugin root',
};

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({
  plugin: z.unknown(),
}).strict();

/**
 * The #468 probe: `(await agent()).plugin` as the route sees it, so every proof
 * level can assert the anchor a generated scope resolved from
 * `AGENT_BUNDLE_PLUGIN_ROOT` (or its fallback) reached the request.
 */
export default async function PluginRoot() {
  const { plugin } = await agent();
  const observed: JsonValue = plugin.state === 'available'
    ? { source: plugin.source, state: plugin.state, value: { root: plugin.value.root, stateRoot: plugin.value.stateRoot } }
    : { reason: plugin.reason, state: plugin.state };
  return (
    <Agent.Result value={{ plugin: observed }}>
      <Agent.Text>{plugin.state === 'available' ? `plugin root: ${plugin.value.root}` : `plugin root unavailable: ${plugin.reason}`}</Agent.Text>
    </Agent.Result>
  );
}
