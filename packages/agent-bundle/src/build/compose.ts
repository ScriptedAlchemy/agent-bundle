import { componentKindCapabilityName, type AgentComponentKind } from '../core/components.ts';
import { deduplicateDiagnostics, DiagnosticBag, type Diagnostic } from '../core/diagnostics.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import { projectionIdentity, sortedProjections } from '../adapters/composite-layout.ts';
import { intersectNoticeDeliveryAdvertisements } from '../adapters/capability-state.ts';
import type { NoticeDeliveryAdvertisement } from '../adapters/notice-delivery.ts';
import type { TargetRegistry } from '../adapters/registry.ts';
import {
  sortedEntries,
  type TargetArtifactEntry,
  type TargetArtifactPlan,
  type TargetHookEntry,
} from '../adapters/types.ts';
import { installSurfaceEntries } from '../install/surface.ts';
import { cliBinCollisionDiagnostics, targetHostsGeneratedBin } from './cli-bins.ts';

/**
 * One selected host's projection into the composite root (#555): the plan its
 * adapter produced for the whole normalized model, before the projections are
 * merged into the single tree the build stages.
 */
interface ComposedProjection {
  /** True when the host's adapter publishes the `cli` capability, admitting the routed CLI bin. */
  readonly cliBin: boolean;
  readonly name: string;
  readonly plan: TargetArtifactPlan;
}

/**
 * The one artifact tree the build stages at `artifactRoot`: every selected
 * projection merged by path, plus the install surface written once for the
 * whole selection.
 */
export interface CompositePlan {
  /** True when any selected host admits the routed CLI bin. */
  readonly cliBin: boolean;
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
  /** The selection as one identity: sorted host names joined by `+`. */
  readonly identity: string;
  /**
   * The notice delivery advertisement every selected host honours: the
   * intersection of the hosts' own advertisements, so the shared MCP entries
   * and every host's hook wrappers agree on the routes they may use. Absent
   * when a selected host advertises nothing.
   */
  readonly noticeDelivery: NoticeDeliveryAdvertisement | undefined;
  /** The selected projections, sorted by host name. */
  readonly projections: readonly ComposedProjection[];
  /** The selected host names, sorted. */
  readonly selected: readonly string[];
}

const sameBytes = (left: TargetArtifactEntry, right: TargetArtifactEntry): boolean => {
  if (left.kind === 'write' && right.kind === 'write') return left.content === right.content;
  if (left.kind === 'copy' && right.kind === 'copy') {
    return left.source === right.source && (left.prebuilt === true) === (right.prebuilt === true);
  }
  return false;
};

const collisionDiagnostic = (relativePath: string, owners: readonly string[]): Diagnostic => {
  const component = relativePath.includes('/') ? relativePath.slice(0, relativePath.indexOf('/')) : 'root';
  return {
    code: 'AB4103',
    generatedPath: relativePath,
    message: `${component} component path ${JSON.stringify(relativePath)} is planned with different contents by the ${owners.join(' and ')} projections; deterministic projection ordering cannot choose one without changing native precedence.`,
    recovery: 'Build the conflicting hosts into separate artifacts (one `targets` entry per build), or make the component identical for every selected host.',
    severity: 'error',
  };
};

interface MergedEntries {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
}

/**
 * Merges the selected projections into one tree. Byte-identical entries at
 * one path (a skill every host copies, a shared script) are kept once; a path
 * two projections plan with different bytes is fatal (`AB4103`). Projections
 * are visited in host-name order and entries in path order, so the same
 * selection reports the same collision no matter how `targets` was written.
 */
const mergeEntries = (
  owned: readonly { readonly entries: readonly TargetArtifactEntry[]; readonly owner: string }[],
): MergedEntries => {
  const byPath = new Map<string, { entry: TargetArtifactEntry; owners: string[]; conflicting: string[] }>();
  for (const { entries, owner } of owned) {
    for (const entry of sortedEntries([...entries])) {
      const existing = byPath.get(entry.relativePath);
      if (existing === undefined) {
        byPath.set(entry.relativePath, { conflicting: [], entry, owners: [owner] });
        continue;
      }
      if (sameBytes(existing.entry, entry)) {
        existing.owners.push(owner);
        continue;
      }
      existing.conflicting.push(owner);
    }
  }
  const diagnostics: Diagnostic[] = [];
  const entries: TargetArtifactEntry[] = [];
  for (const [relativePath, merged] of [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (merged.conflicting.length > 0) {
      diagnostics.push(collisionDiagnostic(relativePath, sortedProjections([...merged.owners, ...merged.conflicting])));
      continue;
    }
    entries.push(merged.entry);
  }
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), entries: sortedEntries(entries) });
};

/**
 * The host-scopable component kinds a host discovers by scanning a
 * conventional directory of the plugin root rather than by following a
 * manifest pointer. Every built-in host that declares one of these
 * directories in its artifact layout reads it that way (`commands/` for
 * Claude Code and Cursor, `rules/` for Cursor), so inside one composite root
 * a component scoped to fewer hosts than share the directory is discovered by
 * a host it was not declared for. Skills are discovered the same way
 * (`skills/` for every host) but are never host-scoped: normalization gives
 * every skill every selected target, and a per-host frontmatter extension
 * changes the lowered bytes instead, which the merge reports as `AB4103`.
 */
type ConventionalKind = Extract<AgentComponentKind, 'command' | 'rule'>;

const conventionalKinds: readonly ConventionalKind[] = Object.freeze(['command', 'rule']);

const kindLabel: Readonly<Record<ConventionalKind, string>> = Object.freeze({
  command: 'Command',
  rule: 'Rule',
});

const conventionalDirectory = (registry: TargetRegistry, host: string, kind: ConventionalKind): string | undefined => {
  const layout = registry.artifactLayout(host);
  switch (kind) {
    case 'command':
      return layout.commands?.directory;
    case 'rule':
      return layout.rules?.directory;
    default: {
      const exhaustive: never = kind;
      throw new TypeError(`Unknown conventional component kind ${String(exhaustive)}.`);
    }
  }
};

interface ScopedComponent {
  readonly kind: ConventionalKind;
  readonly name: string;
  readonly sourcePath: string;
  readonly targets: readonly string[];
}

const scopedComponents = (model: NormalizedPlugin): readonly ScopedComponent[] => [
  ...(model.commands ?? []).map((command): ScopedComponent => ({
    kind: 'command', name: command.name, sourcePath: command.provenance.sourcePath, targets: command.targets,
  })),
  ...(model.rules ?? []).map((rule): ScopedComponent => ({
    kind: 'rule', name: rule.name, sourcePath: rule.provenance.sourcePath, targets: rule.targets,
  })),
];

/**
 * AB4105 (#555, decision D5): a host-scoped component that another selected
 * host would discover conventionally cannot be isolated inside one composite
 * root, so the build refuses rather than leaking it. A host "reads" a kind
 * when its adapter both hosts the component kind and declares the directory
 * the emitting host writes it to. Per-host duplicated views are a later step.
 */
const scopeLeakDiagnostics = (
  model: NormalizedPlugin,
  registry: TargetRegistry,
  selected: readonly string[],
): readonly Diagnostic[] => {
  const readers = new Map<ConventionalKind, readonly { readonly directory: string; readonly host: string }[]>(
    conventionalKinds.map((kind) => {
      const capability = componentKindCapabilityName(kind);
      return [kind, selected.flatMap((host) => {
        const directory = conventionalDirectory(registry, host, kind);
        return directory !== undefined && capability !== undefined && registry.hostsComponent(host, capability)
          ? [{ directory, host }]
          : [];
      })];
    }),
  );
  return scopedComponents(model).flatMap((component): Diagnostic[] => {
    const kindReaders = readers.get(component.kind) ?? [];
    const emitters = kindReaders.filter((reader) => component.targets.includes(reader.host));
    if (emitters.length === 0) return [];
    const directories = new Set(emitters.map((emitter) => emitter.directory));
    const leakedTo = kindReaders
      .filter((reader) => !component.targets.includes(reader.host) && directories.has(reader.directory))
      .map((reader) => reader.host)
      .sort((left, right) => left.localeCompare(right));
    if (leakedTo.length === 0) return [];
    const directory = [...directories].sort((left, right) => left.localeCompare(right)).join(', ');
    const scoped = [...component.targets].filter((target) => selected.includes(target)).sort((left, right) => left.localeCompare(right));
    return [{
      code: 'AB4105',
      message: `${kindLabel[component.kind]} ${JSON.stringify(component.name)} is scoped to ${scoped.map((target) => JSON.stringify(target)).join(', ')} but ${leakedTo.map((host) => JSON.stringify(host)).join(', ')} also discover ${JSON.stringify(`${directory}/`)} conventionally in the composite root; a host-scoped component cannot be isolated there.`,
      recovery: 'Extend the component `targets` to every selected host that discovers its directory, or build those hosts into separate artifacts (one `targets` entry per build).',
      severity: 'error',
      sourcePath: component.sourcePath,
    }];
  });
};

const compositeNoticeDelivery = (
  registry: TargetRegistry,
  selected: readonly string[],
): NoticeDeliveryAdvertisement | undefined => {
  const advertisements = selected.map((host) => registry.noticeDelivery(host));
  if (advertisements.some((advertisement) => advertisement === undefined)) return undefined;
  const [first, ...rest] = advertisements as readonly NoticeDeliveryAdvertisement[];
  return first === undefined ? undefined : rest.reduce(intersectNoticeDeliveryAdvertisements, first);
};

/** A composite plan beside every diagnostic its planning raised, fatal or not. */
export interface CompositePlanning {
  readonly diagnostics: readonly Diagnostic[];
  readonly plan: CompositePlan;
}

/**
 * Plans the selected host projections into one composite root (#555) without
 * judging the outcome. Only the planners of the selected hosts run, each over
 * the whole model; a declaration reaches the root when its target set
 * intersects the selection while every emitted host document keeps its own
 * per-host scoping. Projection, collision (`AB4103`), and scope-leak
 * (`AB4105`) diagnostics are returned beside the plan so `validate` and
 * `inspect` report exactly what `build` would refuse.
 */
export const planComposite = (model: NormalizedPlugin, registry: TargetRegistry): CompositePlanning => {
  const selected = sortedProjections(model.targets.map((target) => target.name));
  const diagnostics: Diagnostic[] = [];
  const projections = selected.map((name): ComposedProjection => {
    const plan = registry.get(name).plan(model);
    diagnostics.push(...plan.diagnostics);
    for (const hookEntry of plan.hookEntries ?? []) {
      if (hookEntry.target !== name) {
        diagnostics.push({
          code: 'AB5000',
          message: `Target adapter ${JSON.stringify(name)} planned hook ${JSON.stringify(hookEntry.hook.id)} for target ${JSON.stringify(hookEntry.target)}, expected ${JSON.stringify(name)}.`,
          severity: 'error',
          target: name,
        });
      }
    }
    const cliBin = targetHostsGeneratedBin(registry, model, name);
    if (cliBin) diagnostics.push(...cliBinCollisionDiagnostics(model, name, plan.entries));
    return Object.freeze({ cliBin, name, plan });
  });
  const merged = mergeEntries([
    ...projections.map((projection) => ({ entries: projection.plan.entries, owner: projection.name })),
    { entries: installSurfaceEntries(model, registry.builtInHosts(selected)), owner: 'install surface' },
  ]);
  diagnostics.push(...merged.diagnostics, ...scopeLeakDiagnostics(model, registry, selected));
  return Object.freeze({
    diagnostics: Object.freeze(deduplicateDiagnostics(diagnostics)),
    plan: Object.freeze({
      cliBin: projections.some((projection) => projection.cliBin),
      entries: merged.entries,
      hookEntries: Object.freeze(projections.flatMap((projection) => projection.plan.hookEntries ?? [])),
      identity: projectionIdentity(selected),
      noticeDelivery: compositeNoticeDelivery(registry, selected),
      projections: Object.freeze(projections),
      selected,
    }),
  });
};

/**
 * The composite plan a build stages: `planComposite` judged, throwing a
 * `DiagnosticError` when any projection, collision (`AB4103`), or scope leak
 * (`AB4105`) is fatal.
 */
export const composeProjections = (model: NormalizedPlugin, registry: TargetRegistry): CompositePlan => {
  const planning = planComposite(model, registry);
  new DiagnosticBag(planning.diagnostics).throwIfErrors();
  return planning.plan;
};
