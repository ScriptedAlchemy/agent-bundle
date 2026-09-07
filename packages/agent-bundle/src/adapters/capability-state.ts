import { CapabilityStateError, unknownCapabilityStateError } from '../core/capabilities.ts';
import type { CapabilityEvidence, CapabilityState } from '../core/capabilities.ts';
import { featureCapabilityName } from '../core/components.ts';
import { isRelocatablePosixPath } from '../core/paths.ts';
import type { JsonObject } from '../core/strict-json.ts';
import {
  NOTICE_DELIVERY_ROUTES,
  NOTICE_SENSITIVITIES,
  type NoticeDeliveryAdvertisement,
  type NoticeDeliveryRoute,
  type NoticeDeliveryRouteState,
  type NoticeSensitivity,
} from './notice-delivery.ts';
import type { TargetAdapterMetadata } from './types.ts';

export { featureCapabilityName } from '../core/components.ts';

/** Builds immutable evidence from a target's pinned capability-table metadata. */
export const capabilityEvidence = (
  target: string,
  metadata: TargetAdapterMetadata,
): CapabilityEvidence => Object.freeze({
  observedVersion: metadata.observedVersion,
  target,
});

export const supportedCapability = (evidence: CapabilityEvidence): CapabilityState => Object.freeze({
  evidence,
  state: 'supported',
});

/**
 * The capability that admits the compiled routed CLI (`src/cli/**`) into a
 * target's host artifact as `bin/<plugin-name>.mjs` (#387). It asks nothing of
 * the host beyond what `scripts/` and `mcp/` entries already rely on — the
 * artifact root is installed as a plain directory Node can execute from — so a
 * target publishes it whenever its plugin root is such a directory. An adapter
 * that publishes no row reads as an honest `unavailable`, and the bin is
 * omitted from that target with an inspect entry naming the reason.
 */
export const cliBinCapability = 'cli';

/** Capability for the framework-owned `<plugin> web` command (#564). */
export const webSurfaceCapability = 'web';

export const unavailableCapability = (reason: string): CapabilityState => Object.freeze({
  reason,
  state: 'unavailable',
});

/** A row from a pinned host capability table. */
export interface CapabilityRow {
  readonly availability?: Readonly<Record<string, { readonly reason?: string; readonly state?: string }>>;
  readonly evidence?: readonly string[];
  readonly nativeEvent?: string;
  readonly payload?: JsonObject;
  readonly reason?: string;
  readonly state?: string;
}

/** A loaded pinned host capability table and its source identity. */
export interface HostCapabilityTable {
  readonly data: JsonObject;
  readonly fileName: string;
  readonly host: string;
  readonly version: string;
}

export interface EventRouteCapabilityTableEntry {
  readonly nativeEvent?: string;
  /**
   * The host's spelling of each canonical payload field for this family (#466):
   * the native key, or `{ nativeKey, decode }` when a transformation applies.
   * Mirrors `agentEventPayloadNativeKeys` in `routes/events.ts` (the runtime
   * table) so the generated events reference documents the mapping per host;
   * `tests/event-payload.test.ts` holds the two equal.
   */
  readonly payload?: Readonly<Record<string, string | { readonly decode?: string; readonly nativeKey: string }>>;
  readonly reason?: string;
  /** JSON imports widen literals; unsupported table states fail closed below. */
  readonly state: string;
}

const eventRouteRequirementFeatures: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'session/start': Object.freeze(['context']),
  stop: Object.freeze(['deny']),
  'tool/after': Object.freeze(['context']),
  'tool/before': Object.freeze(['deny']),
});

const eventRequirementName = (event: string): string =>
  `events.${event.replace(/\/(.)/gu, (_, character: string) => character.toUpperCase())}`;

/**
 * Converts a pinned host table's semantic-event rows into the shared
 * capability-state namespace consumed by route validation and inspect.
 */
export const eventRouteCapabilitiesFrom = (
  routes: Readonly<Record<string, EventRouteCapabilityTableEntry>>,
  evidence: CapabilityEvidence,
): Readonly<Record<string, CapabilityState>> => Object.freeze(Object.fromEntries(
  Object.entries(routes).sort(([left], [right]) => left.localeCompare(right)).flatMap(([event, capability]) => {
    let state: CapabilityState;
    switch (capability.state) {
      case 'supported':
        state = supportedCapability(evidence);
        break;
      case 'unavailable':
        state = unavailableCapability(capability.reason ?? `The pinned ${evidence.target} contract does not support ${event}.`);
        break;
      default:
        throw new TypeError(`Unsupported event-route capability state ${JSON.stringify(capability.state)} for ${event}.`);
    }
    const requirement = eventRequirementName(event);
    return [
      [`event:${event}`, state],
      ...(eventRouteRequirementFeatures[event] ?? []).map((feature) => [`${requirement}.${feature}`, state] as const),
    ];
  }),
));

export const supportedEventRouteNamesFrom = (
  routes: Readonly<Record<string, EventRouteCapabilityTableEntry>>,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(routes)
    .filter(([, capability]) => capability.state === 'supported' && typeof capability.nativeEvent === 'string')
    .map(([event, capability]) => [event, capability.nativeEvent!]),
));

/** A pinned capability-table row: JSON imports widen the state literal, so unknown states fail closed. */
export interface CapabilityTableRow extends CapabilityRow {
  readonly state: string;
}

export interface NoticeDeliveryCapabilityTableEntry {
  readonly reason?: string;
  /** The most sensitive notice class the route carries in full; JSON widens the literal. */
  readonly sensitivity?: string;
  /** Dated evidence for `sensitivity`; required whenever a ceiling is named. */
  readonly sensitivityEvidence?: string;
  /** JSON imports widen literals; unknown table states fail closed below. */
  readonly state: string;
}

const sensitivityRank: Readonly<Record<NoticeSensitivity, number>> = Object.freeze({ internal: 1, public: 0, secret: 2 });

/** The ceiling a supported row admits; absent means `internal` (the pre-sensitivity contract). */
const routeCeiling = (entry: NoticeDeliveryRouteState): NoticeSensitivity | undefined =>
  entry.state === 'supported' ? entry.sensitivity ?? 'internal' : undefined;

const isNoticeSensitivity = (value: unknown): value is NoticeSensitivity =>
  typeof value === 'string' && (NOTICE_SENSITIVITIES as readonly string[]).includes(value);

/**
 * An `unavailable` notice route must say when the host was surveyed: the
 * reason carries an ISO calendar date (`YYYY-MM-DD`), as every pinned table
 * does, so the advertisement's evidence can be re-checked against a later pin.
 */
const DATED_REASON = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/u;

/**
 * Converts one pinned table row into the shared capability-state namespace.
 * `supported` and `degraded` carry the adapter's pinned evidence identity;
 * `unavailable` and `prohibited` carry the table's dated reason.
 */
export const capabilityFromTableRow = (
  row: CapabilityTableRow,
  evidence: CapabilityEvidence,
): CapabilityState => {
  switch (row.state) {
    case 'supported':
      return supportedCapability(evidence);
    case 'degraded':
      return Object.freeze({ evidence, reason: row.reason ?? '', state: 'degraded' });
    case 'unavailable':
      return unavailableCapability(row.reason ?? `The pinned ${evidence.target} contract does not support this surface.`);
    case 'prohibited':
      return Object.freeze({
        reason: row.reason ?? `The pinned ${evidence.target} contract prohibits this surface.`,
        state: 'prohibited',
      });
    default:
      throw new TypeError(`Unsupported ${evidence.target} capability-table state ${JSON.stringify(row.state)}.`);
  }
};

/** Publishes one row per feature from a pinned `{ <feature>: row }` table block. */
export const featureCapabilitiesFrom = (
  kindCapability: string,
  features: Readonly<Record<string, CapabilityTableRow>>,
  evidence: CapabilityEvidence,
): Readonly<Record<string, CapabilityState>> => Object.freeze(Object.fromEntries(
  Object.entries(features)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, row]) => [featureCapabilityName(kindCapability, feature), capabilityFromTableRow(row, evidence)]),
));

/**
 * Publishes one row per frontmatter field from a pinned frontmatter block whose
 * single state covers every field (`fields` is a list or an authored→emitted map).
 */
export const frontmatterFeatureCapabilitiesFrom = (
  kindCapability: string,
  block: CapabilityTableRow & { readonly fields: readonly string[] | Readonly<Record<string, string>> },
  evidence: CapabilityEvidence,
): Readonly<Record<string, CapabilityState>> => {
  const fields = Array.isArray(block.fields) ? block.fields : Object.keys(block.fields);
  return Object.freeze(Object.fromEntries(
    [...fields]
      .sort((left, right) => left.localeCompare(right))
      .map((field) => [featureCapabilityName(kindCapability, field), capabilityFromTableRow(block, evidence)]),
  ));
};

/**
 * Converts a pinned host table's `noticeDelivery` rows into the typed
 * advertisement the notice router consumes (#99 stage 4). Every route in the
 * taxonomy must be present and `unavailable` rows must carry their dated
 * reason; a row the table does not know how to describe fails closed rather
 * than becoming a fabricated channel.
 */
export const noticeDeliveryAdvertisementFrom = (
  target: string,
  rows: Readonly<Record<string, NoticeDeliveryCapabilityTableEntry>>,
): NoticeDeliveryAdvertisement => {
  const entries = NOTICE_DELIVERY_ROUTES.map((route): [NoticeDeliveryRoute, NoticeDeliveryRouteState] => {
    const row = rows[route];
    if (row === undefined) {
      throw new CapabilityStateError(`The pinned ${target} table advertises no notice delivery route ${route}.`);
    }
    switch (row.state) {
      case 'supported': {
        if (row.sensitivity === undefined) return [route, Object.freeze({ state: 'supported' })];
        if (!isNoticeSensitivity(row.sensitivity)) {
          throw new CapabilityStateError(
            `Unsupported notice sensitivity ${JSON.stringify(row.sensitivity)} for ${route} in the pinned ${target} table.`,
          );
        }
        if (typeof row.sensitivityEvidence !== 'string' || !DATED_REASON.test(row.sensitivityEvidence)) {
          throw new CapabilityStateError(
            `The pinned ${target} table names a ${row.sensitivity} sensitivity ceiling for notice delivery route ${route} without dated evidence (an ISO date such as 2026-09-03 naming when the host was surveyed).`,
          );
        }
        return [route, Object.freeze({
          sensitivity: row.sensitivity,
          sensitivityEvidence: row.sensitivityEvidence,
          state: 'supported',
        })];
      }
      case 'unavailable':
        if (typeof row.reason !== 'string' || !DATED_REASON.test(row.reason)) {
          throw new CapabilityStateError(
            `The pinned ${target} table marks notice delivery route ${route} unavailable without a dated reason (an ISO date such as 2026-09-02 naming when the host was surveyed).`,
          );
        }
        return [route, Object.freeze({ reason: row.reason, state: 'unavailable' })];
      default:
        throw new CapabilityStateError(
          `Unsupported notice delivery route state ${JSON.stringify(row.state)} for ${route} in the pinned ${target} table.`,
        );
    }
  });
  return Object.freeze(Object.fromEntries(entries)) as NoticeDeliveryAdvertisement;
};

/**
 * Intersects host advertisements for a composite adapter: a route is
 * supported only where every host supports it, and the dated reasons of the
 * hosts that do not are kept so the composite stays as honest as its parts.
 * A supported route's sensitivity ceiling is the lower of the two, with the
 * evidence of the host that set it; two hosts at the same ceiling keep both
 * pieces of evidence.
 */
export const intersectNoticeDeliveryAdvertisements = (
  left: NoticeDeliveryAdvertisement,
  right: NoticeDeliveryAdvertisement,
): NoticeDeliveryAdvertisement => Object.freeze(Object.fromEntries(
  NOTICE_DELIVERY_ROUTES.map((route): [NoticeDeliveryRoute, NoticeDeliveryRouteState] => {
    const entries = [left[route], right[route]];
    const reasons = entries.flatMap((entry) => (entry.state === 'unavailable' ? [entry.reason] : []));
    if (reasons.length > 0) {
      return [route, Object.freeze({
        reason: [...new Set(reasons)].sort((first, second) => first.localeCompare(second)).join('; '),
        state: 'unavailable',
      })];
    }
    const ceilings = entries.map((entry) => routeCeiling(entry) ?? 'internal');
    const lowest = ceilings.reduce((low, ceiling) => (sensitivityRank[ceiling] < sensitivityRank[low] ? ceiling : low));
    const evidence = [...new Set(entries.flatMap((entry) =>
      entry.state === 'supported' && (entry.sensitivity ?? 'internal') === lowest && entry.sensitivityEvidence !== undefined
        ? [entry.sensitivityEvidence]
        : []))].sort((first, second) => first.localeCompare(second));
    // An `internal` ceiling nobody evidenced is the bare pre-sensitivity row;
    // a named ceiling always travels with the evidence of the host that set it.
    if (evidence.length === 0) {
      return [route, Object.freeze({ state: 'supported' })];
    }
    return [route, Object.freeze({
      sensitivity: lowest,
      sensitivityEvidence: evidence.join('; '),
      state: 'supported',
    })];
  }),
)) as NoticeDeliveryAdvertisement;

/**
 * The surfaces every third-party client record is judged on (#693–#714).
 * A record declares all of them, so a client that loads the manifest but not
 * the hooks file says so in a row and the install surface never implies a
 * surface the client's own documentation withholds.
 */
const CLIENT_COMPATIBILITY_SURFACES: readonly string[] =
  Object.freeze(['manifest', 'skills', 'mcp', 'placeholders', 'hooks']);

/** What the client loads from the emitted artifact, and therefore what its record may promise. */
const CLIENT_COMPATIBILITY_TIERS: readonly string[] =
  Object.freeze(['agent-plugins', 'skills', 'none']);

/**
 * The artifact path each surface is read from, so a record that says it loads
 * a surface has to name the file it loads, and a renderer can tell which
 * surfaces a build actually wrote. `placeholders` is a behavior of the MCP
 * document, so it is read from the same file; `hooks` has no file at all,
 * because Agent Plugins 1.0.0 defines none.
 */
export const CLIENT_SURFACE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  manifest: 'plugin.json',
  mcp: 'mcp.json',
  placeholders: 'mcp.json',
  skills: 'skills',
});

/**
 * What a recorded install command does. A command's role is declared, never
 * inferred from its position: a client whose verifier is listed first must not
 * be documented as installing with it.
 */
const CLIENT_INSTALL_ROLES: readonly string[] =
  Object.freeze(['install', 'register', 'trust', 'enable', 'verify', 'inspect', 'remove']);

/**
 * The one action that makes the artifact loadable: `install` for a client that
 * takes a copy into its own store, `register` for one that reads the emitted
 * tree where it lies once a path or setting names it.
 */
const CLIENT_INSTALL_ANCHORS: readonly string[] = Object.freeze(['install', 'register']);

/**
 * Where the recorded install command takes the artifact from. `local-directory`
 * is only for a client whose own documentation installs a directory path;
 * `marketplace` and `repository` record a client that publishes no verified
 * local form, so the install surface never prints an unproven recipe against
 * the emitted bundle. An indexed marketplace name and a Git `owner/repository`
 * are separate inputs wherever a client's own documentation separates them.
 */
const CLIENT_INSTALL_SOURCES: readonly string[] =
  Object.freeze(['local-directory', 'marketplace', 'repository']);

/** One authored client row from a pinned table's `clients` block. */
export interface ClientCompatibilityTableEntry {
  readonly discovery: {
    readonly evidence?: readonly string[];
    /** Per-file precedence: the paths that win, and the surfaces each one takes. */
    readonly shadowedBy?: readonly { readonly path?: string; readonly surfaces?: readonly string[] }[];
    /** Artifact-relative paths the client must find for the recorded tier to hold. */
    readonly required?: readonly string[];
  };
  readonly install?: {
    readonly actions?: readonly { readonly command?: string; readonly role?: string }[];
    readonly location?: string;
    readonly source?: string;
  };
  readonly issue?: number;
  readonly name?: string;
  /** The client version, release channel, or documentation date the rows were read against. */
  readonly observed?: string;
  readonly surfaces?: Readonly<Record<string, CapabilityTableRow>>;
  /** JSON imports widen literals; unknown tiers fail closed below. */
  readonly tier?: string;
}

/** One recorded install command with the role its own documentation gives it. */
export interface ClientInstallAction {
  readonly command: string;
  readonly role: string;
}

/** One path that wins over the emitted artifact, and the surfaces it takes. */
export interface ClientShadow {
  readonly path: string;
  readonly surfaces: readonly string[];
}

/** A validated client record: the install surface and generated matrix render these. */
export interface ClientCompatibilityRecord {
  readonly discovery: {
    readonly evidence: readonly string[];
    readonly required: readonly string[];
    readonly shadowedBy: readonly ClientShadow[];
  };
  readonly id: string;
  readonly install?: {
    readonly actions: readonly ClientInstallAction[];
    readonly location?: string;
    readonly source: string;
  };
  readonly issue: number;
  readonly name: string;
  readonly observed: string;
  readonly surfaces: Readonly<Record<string, CapabilityTableRow>>;
  readonly tier: string;
}

const CLIENT_ID = /^[a-z\d]+(?:-[a-z\d]+)*$/u;

const clientPaths = (
  target: string,
  id: string,
  field: string,
  value: readonly string[] | undefined,
): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !isRelocatablePosixPath(entry))) {
    throw new CapabilityStateError(
      `The pinned ${target} table declares ${field} for client ${id} as something other than artifact-relative paths.`,
    );
  }
  return Object.freeze([...value].sort((left, right) => left.localeCompare(right)));
};

/**
 * Precedence is per file and per surface: a client that prefers `.mcp.json`
 * over the emitted `mcp.json` still reads the shared skill tree, so a shadow
 * names the surfaces it takes rather than replacing the whole root. Authored
 * order is kept, because a client that publishes a precedence order among
 * these files publishes it in that order.
 */
const clientShadows = (
  target: string,
  id: string,
  value: readonly { readonly path?: string; readonly surfaces?: readonly string[] }[] | undefined,
): readonly ClientShadow[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new CapabilityStateError(`The pinned ${target} table declares discovery.shadowedBy for client ${id} as something other than a list.`);
  }
  return Object.freeze(value
    .map((shadow): ClientShadow => {
      if (typeof shadow?.path !== 'string' || !isRelocatablePosixPath(shadow.path)) {
        throw new CapabilityStateError(
          `The pinned ${target} table declares a discovery.shadowedBy path for client ${id} that is not an artifact-relative path.`,
        );
      }
      const surfaces = shadow.surfaces ?? [];
      if (!Array.isArray(surfaces) || surfaces.length === 0 || surfaces.some((surface) => !CLIENT_COMPATIBILITY_SURFACES.includes(surface))) {
        throw new CapabilityStateError(
          `The pinned ${target} table shadows ${shadow.path} for client ${id} without naming the surfaces it takes (${CLIENT_COMPATIBILITY_SURFACES.join(', ')}).`,
        );
      }
      return Object.freeze({
        path: shadow.path,
        surfaces: Object.freeze(CLIENT_COMPATIBILITY_SURFACES.filter((surface) => surfaces.includes(surface))),
      });
    }));
};

/**
 * A recorded install block. Every command declares its role, so the install
 * surface prints the client's own install command instead of whichever one the
 * record happens to list first, and `source` says whether that command was
 * documented against a local directory at all.
 */
const clientInstall = (
  target: string,
  id: string,
  install: ClientCompatibilityTableEntry['install'],
): ClientCompatibilityRecord['install'] => {
  if (install === undefined) return undefined;
  if (!CLIENT_INSTALL_SOURCES.includes(install.source ?? '')) {
    throw new CapabilityStateError(
      `The pinned ${target} table gives client ${id} an install block with source ${JSON.stringify(install.source)} (expected ${CLIENT_INSTALL_SOURCES.join(' or ')}).`,
    );
  }
  const actions = install.actions ?? [];
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new CapabilityStateError(`The pinned ${target} table gives client ${id} an install block with no actions.`);
  }
  const validated = actions.map((action): ClientInstallAction => {
    if (!CLIENT_INSTALL_ROLES.includes(action?.role ?? '')) {
      throw new CapabilityStateError(
        `The pinned ${target} table gives client ${id} an install action with role ${JSON.stringify(action?.role)} (expected ${CLIENT_INSTALL_ROLES.join(', ')}).`,
      );
    }
    if (typeof action.command !== 'string' || action.command.trim().length === 0) {
      throw new CapabilityStateError(`The pinned ${target} table gives client ${id} a ${action.role} action with no verbatim command.`);
    }
    return Object.freeze({ command: action.command, role: action.role! });
  });
  const anchors = validated.filter((action) => CLIENT_INSTALL_ANCHORS.includes(action.role));
  if (anchors.length !== 1) {
    throw new CapabilityStateError(`The pinned ${target} table gives client ${id} an install block without exactly one ${CLIENT_INSTALL_ANCHORS.join(' or ')} action.`);
  }
  // Registration names the emitted tree where it lies, so it is a local
  // directory by definition: a registered marketplace or repository entry
  // would render as an install of something this artifact is not.
  if (anchors[0]!.role === 'register' && install.source !== 'local-directory') {
    throw new CapabilityStateError(
      `The pinned ${target} table gives client ${id} a register action against a ${install.source} source (expected local-directory).`,
    );
  }
  return Object.freeze({
    actions: Object.freeze(validated),
    ...(install.location === undefined ? {} : { location: install.location }),
    source: install.source!,
  });
};

const clientSurfaces = (
  target: string,
  id: string,
  surfaces: Readonly<Record<string, CapabilityTableRow>> | undefined,
): Readonly<Record<string, CapabilityTableRow>> => Object.freeze(Object.fromEntries(
  CLIENT_COMPATIBILITY_SURFACES.map((surface): [string, CapabilityTableRow] => {
    const row = surfaces?.[surface];
    if (row === undefined) {
      throw new CapabilityStateError(`The pinned ${target} table leaves client ${id} silent about its ${surface} surface.`);
    }
    const dated = (field: string, value: unknown): readonly string[] => {
      const notes = value === undefined ? [] : value as readonly string[];
      if (!Array.isArray(notes) || notes.some((note) => typeof note !== 'string' || !DATED_REASON.test(note))) {
        throw new CapabilityStateError(
          `The pinned ${target} table gives client ${id} an undated ${field} note for ${surface} (an ISO date such as 2026-09-06 naming when the client's documentation was read).`,
        );
      }
      return Object.freeze([...notes]);
    };
    const requireReason = (): string => {
      if (typeof row.reason !== 'string' || !DATED_REASON.test(row.reason)) {
        throw new CapabilityStateError(
          `The pinned ${target} table marks the ${surface} surface of client ${id} ${row.state} without a dated reason.`,
        );
      }
      return row.reason;
    };
    switch (row.state) {
      case 'supported': {
        const evidence = dated('evidence', row.evidence);
        if (evidence.length === 0) {
          throw new CapabilityStateError(
            `The pinned ${target} table marks the ${surface} surface of client ${id} supported without evidence.`,
          );
        }
        return [surface, Object.freeze({ evidence, state: 'supported' })];
      }
      case 'degraded': {
        const evidence = dated('evidence', row.evidence);
        if (evidence.length === 0) {
          throw new CapabilityStateError(
            `The pinned ${target} table marks the ${surface} surface of client ${id} degraded without evidence of the part it does load.`,
          );
        }
        return [surface, Object.freeze({ evidence, reason: requireReason(), state: 'degraded' })];
      }
      case 'unavailable':
      case 'prohibited':
        return [surface, Object.freeze({ reason: requireReason(), state: row.state })];
      default:
        throw new CapabilityStateError(
          `Unsupported ${surface} state ${JSON.stringify(row.state)} for client ${id} in the pinned ${target} table.`,
        );
    }
  }),
));

/**
 * Reads a pinned table's optional `clients` block: the third-party clients
 * that load the artifact this target emits, each pinned to its own
 * documentation (#693–#714). These clients are not target adapters — nothing
 * here changes what the compiler writes — so a record is evidence about a
 * reader of the existing artifact, never a projection. A client whose
 * contract needs a document Agent Bundle does not emit is recorded at the
 * tier it really reaches, and the tier is held to the rows and the paths:
 * `agent-plugins` requires a `plugin.json` the client loads as a manifest,
 * `skills` requires the skill tree, and `none` may name no path or loaded
 * surface at all.
 */
export const clientCompatibilityFrom = (
  target: string,
  clients: Readonly<Record<string, ClientCompatibilityTableEntry>> | undefined,
): readonly ClientCompatibilityRecord[] => Object.freeze(
  Object.entries(clients ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, entry]): ClientCompatibilityRecord => {
      if (!CLIENT_ID.test(id)) {
        throw new CapabilityStateError(`The pinned ${target} table names a client ${JSON.stringify(id)} that is not a kebab-case id.`);
      }
      if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
        throw new CapabilityStateError(`The pinned ${target} table gives client ${id} no display name.`);
      }
      if (!Number.isInteger(entry.issue)) {
        throw new CapabilityStateError(`The pinned ${target} table gives client ${id} no tracking issue number.`);
      }
      if (typeof entry.observed !== 'string' || !DATED_REASON.test(entry.observed)) {
        throw new CapabilityStateError(
          `The pinned ${target} table gives client ${id} no dated observation (the client version or documentation date the rows were read against).`,
        );
      }
      if (!CLIENT_COMPATIBILITY_TIERS.includes(entry.tier ?? '')) {
        throw new CapabilityStateError(`Unsupported tier ${JSON.stringify(entry.tier)} for client ${id} in the pinned ${target} table.`);
      }
      const surfaces = clientSurfaces(target, id, entry.surfaces);
      const required = clientPaths(target, id, 'discovery.required', entry.discovery?.required);
      const supported = (surface: string): boolean => surfaces[surface]!.state !== 'unavailable' && surfaces[surface]!.state !== 'prohibited';
      if (entry.tier === 'agent-plugins' && !(supported('manifest') && required.includes('plugin.json'))) {
        throw new CapabilityStateError(`Client ${id} claims the agent-plugins tier in the pinned ${target} table without reading plugin.json as a manifest it loads.`);
      }
      if (entry.tier === 'skills' && !(supported('skills') && required.includes('skills'))) {
        throw new CapabilityStateError(`Client ${id} claims the skills tier in the pinned ${target} table without reading the skill tree.`);
      }
      if (entry.tier === 'none' && (required.length > 0 || CLIENT_COMPATIBILITY_SURFACES.some((surface) => supported(surface)))) {
        throw new CapabilityStateError(`Client ${id} claims no tier in the pinned ${target} table while recording a path or surface it reads.`);
      }
      // Every loaded surface names the file it is loaded from, so a rendered
      // claim about a surface is a claim about a path the build either wrote
      // or did not.
      for (const [surface, path] of Object.entries(CLIENT_SURFACE_PATHS)) {
        if (supported(surface) && !required.includes(path)) {
          throw new CapabilityStateError(`Client ${id} loads the ${surface} surface in the pinned ${target} table without reading ${path}.`);
        }
      }
      const install = clientInstall(target, id, entry.install);
      const discoveryEvidence = entry.discovery?.evidence ?? [];
      if (!Array.isArray(discoveryEvidence) || discoveryEvidence.some((note) => typeof note !== 'string' || !DATED_REASON.test(note))) {
        throw new CapabilityStateError(`The pinned ${target} table gives client ${id} an undated discovery note.`);
      }
      const shadowedBy = clientShadows(target, id, entry.discovery?.shadowedBy);
      if (discoveryEvidence.length === 0 && required.length + shadowedBy.length > 0) {
        throw new CapabilityStateError(`Client ${id} names artifact paths in the pinned ${target} table with no dated evidence that it reads or shadows them.`);
      }
      if (install?.source === 'local-directory' && entry.tier === 'none') {
        throw new CapabilityStateError(`Client ${id} records a local-directory install in the pinned ${target} table while reading nothing this artifact emits.`);
      }
      return Object.freeze({
        discovery: Object.freeze({
          evidence: Object.freeze([...discoveryEvidence]),
          required,
          shadowedBy,
        }),
        id,
        ...(install === undefined ? {} : { install }),
        issue: entry.issue!,
        name: entry.name,
        observed: entry.observed,
        surfaces,
        tier: entry.tier!,
      });
    }),
);

export const capabilityStateFromSupport = (
  supported: boolean,
  evidence: CapabilityEvidence,
  unavailableReason: string,
): CapabilityState => supported ? supportedCapability(evidence) : unavailableCapability(unavailableReason);

/** The temporary Boolean compatibility rule: only supported maps to true. */
export const capabilityIsSupported = (capability: CapabilityState | undefined): boolean => {
  if (capability === undefined) return false;
  switch (capability.state) {
    case 'supported':
      return true;
    case 'degraded':
    case 'unavailable':
    case 'prohibited':
      return false;
    default: {
      const exhaustive: never = capability;
      throw unknownCapabilityStateError(exhaustive);
    }
  }
};
