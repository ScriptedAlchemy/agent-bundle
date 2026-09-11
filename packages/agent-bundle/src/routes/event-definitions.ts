import { canonicalAgentEvents, type DenyingEvent, type CanonicalAgentEvent } from './events.ts';
import type { AgentRequestContext } from '@agent-bundle/runtime';
import type { AgentEventRouteConfig, AgentEventRouteProps } from './public.ts';

import type { EventHandlerResult } from '../events/handler.ts';
import type { JsonValue } from '../core/strict-json.ts';

export type EventResult<Event extends CanonicalAgentEvent = CanonicalAgentEvent> =
  | Extract<EventHandlerResult, { outcome: 'render' }>
  | void
  | { readonly outcome: 'continue' }
  | (Event extends DenyingEvent ? { readonly outcome: 'deny'; readonly reason: string } : never);

export type EventContext<Event extends CanonicalAgentEvent = CanonicalAgentEvent> = AgentEventRouteProps<Event> & Pick<AgentRequestContext, 'provider' | 'process'> & {
  readonly render: (module: string, data: JsonValue) => Extract<EventHandlerResult, { outcome: 'render' }>;
};

export type EventHandler<Event extends CanonicalAgentEvent = CanonicalAgentEvent> =
  (context: EventContext<Event>) => EventResult<Event> | Promise<EventResult<Event>>;

type Definition<Event extends CanonicalAgentEvent> =
  (config: AgentEventRouteConfig, handler: EventHandler<Event>) => EventHandler<Event>;
type Camel<Key extends string> = Key extends `${infer Left}-${infer Right}` ? `${Left}${Capitalize<Right>}` : Key;
type Families = CanonicalAgentEvent extends infer Event extends string ? Event extends `${infer Family}/${string}` ? Family : Event : never;
type Events = {
  readonly [Family in Families as Camel<Family>]:
    (Family extends CanonicalAgentEvent ? Definition<Family> : unknown) & {
      readonly [Event in CanonicalAgentEvent as Event extends `${Family}/${infer Name}` ? Name : never]: Definition<Event>;
    };
};

const definitions: Record<string, unknown> = {};
for (const event of canonicalAgentEvents) {
  const [family, name] = event.split('/');
  const key = family!.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const define = (config: AgentEventRouteConfig, handler: EventHandler) => Object.assign(handler, { config, event });
  if (name === undefined) definitions[key] = Object.assign(define, definitions[key]);
  else {
    const group = definitions[key] ?? {};
    Object.assign(group, { [name]: define });
    definitions[key] = group;
  }
}

/** Canonical event families, inferred from the same catalog the adapters project. */
export const events = definitions as Events;
