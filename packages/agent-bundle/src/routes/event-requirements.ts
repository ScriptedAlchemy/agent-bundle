import type { NormalizationTargetRegistry } from '../core/types.ts';

export const targetsSatisfyingEventRequirements = (
  requirements: unknown,
  targets: readonly string[],
  registry: Pick<NormalizationTargetRegistry, 'supports'>,
): readonly string[] =>
  !Array.isArray(requirements)
    ? targets
    : targets.filter((target) => requirements.every((requirement) =>
      typeof requirement === 'string' && registry.supports(target, requirement)));
