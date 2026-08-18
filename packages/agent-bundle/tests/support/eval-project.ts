import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface EvalSuiteCaseSpec {
  readonly hosts?: Readonly<Record<string, Readonly<{ readonly model: string }>>>;
  readonly id: string;
  readonly kind: 'activation' | 'fail' | 'pass';
  readonly trials?: number;
}

export interface EvalSuiteSpec {
  readonly cases: readonly EvalSuiteCaseSpec[];
  readonly name: string;
}

export interface SeedEvalProjectOptions {
  readonly marketplace?: boolean;
  readonly semanticGrader?: boolean;
  /** Extra host targets to build, so a native harness has a candidate to evaluate. */
  readonly targets?: readonly string[];
}

const evalEntryPoint = resolve(process.cwd(), 'packages/agent-bundle/src/eval/index.ts');
const sourceEntryPoint = resolve(process.cwd(), 'packages/agent-bundle/src/index.ts');

const graderModule = (expected: string): string => [
  "import { readFile } from 'node:fs/promises';",
  "import { join } from 'node:path';",
  '',
  'export default async ({ fixturePath }: { fixturePath: string }) => {',
  "  const parsed = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as { risk?: string };",
  `  return parsed.risk === ${JSON.stringify(expected)}`,
  `    ? { detail: 'The fixture recorded risk ${expected}.', outcome: 'pass' }`,
  `    : { detail: 'The fixture did not record risk ${expected}.', outcome: 'fail' };`,
  '};',
  '',
].join('\n');

const assertionSource = (spec: EvalSuiteCaseSpec): string => spec.kind === 'activation'
  ? "expectSkillActivation({ skill: 'review' })"
  : `expectOutcome({ script: './graders/${spec.kind === 'pass' ? 'reads' : 'wrong'}-result.ts' })`;

const caseSource = (spec: EvalSuiteCaseSpec): readonly string[] => [
  '    {',
  `      assertions: [${assertionSource(spec)}],`,
  "      fixture: './fixtures/repo',",
  `      hosts: ${JSON.stringify(spec.hosts ?? { portable: { model: 'deterministic' } })},`,
  `      id: ${JSON.stringify(spec.id)},`,
  "      invocation: { mode: 'automatic' },",
  `      prompt: ${JSON.stringify(`Report the highest-risk regression for ${spec.id}.`)},`,
  ...(spec.trials === undefined ? [] : [`      trials: ${spec.trials},`]),
  '    },',
];

/** Emits an authored suite module exactly as a project author would check one in. */
export const writeEvalSuite = async (
  root: string,
  fileName: string,
  spec: EvalSuiteSpec,
): Promise<void> => {
  const helpers = [
    ...(spec.cases.some((entry) => entry.kind !== 'activation') ? ['expectOutcome'] : []),
    ...(spec.cases.some((entry) => entry.kind === 'activation') ? ['expectSkillActivation'] : []),
  ];
  await mkdir(join(root, 'evals'), { recursive: true });
  await writeFile(join(root, 'evals', fileName), [
    `import { defineEvalSuite, ${helpers.join(', ')} } from 'agent-bundle/eval';`,
    '',
    'export default defineEvalSuite({',
    '  cases: [',
    ...spec.cases.flatMap(caseSource),
    '  ],',
    `  name: ${JSON.stringify(spec.name)},`,
    '});',
    '',
  ].join('\n'));
};

/**
 * Seeds a project whose suites, fixtures, and graders are entirely model-free, so a
 * deterministic run produces one pass, one fail, and one evidence-free inconclusive trial.
 */
export const seedEvalProject = async (
  root: string,
  options: SeedEvalProjectOptions = {},
): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'evals', 'fixtures', 'repo'), { recursive: true }),
    mkdir(join(root, 'evals', 'graders'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, 'node_modules/agent-bundle/package.json'),
      JSON.stringify({
        exports: { '.': './index.ts', './eval': './eval.ts' },
        name: 'agent-bundle',
        type: 'module',
      }),
    ),
    writeFile(join(root, 'node_modules/agent-bundle/eval.ts'), `export * from ${JSON.stringify(evalEntryPoint)};\n`),
    writeFile(
      join(root, 'node_modules/agent-bundle/index.ts'),
      `export { defineConfig } from ${JSON.stringify(sourceEntryPoint)};\n`,
    ),
    writeFile(join(root, 'evals', 'fixtures', 'repo', 'result.json'), '{"risk":"high"}\n'),
    writeFile(join(root, 'evals', 'graders', 'reads-result.ts'), graderModule('high')),
    writeFile(join(root, 'evals', 'graders', 'wrong-result.ts'), graderModule('low')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      ...(options.semanticGrader === true
        ? ["  evals: { semanticGrader: { harness: 'claude', model: 'claude-sonnet-4-5' } },"]
        : []),
      ...(options.marketplace === true ? ['  marketplace: true,'] : []),
      "  plugin: { name: 'review', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      `  targets: ${JSON.stringify(options.targets ?? ['portable'])},`,
      '});',
      '',
    ].join('\n')),
  ]);
  await writeEvalSuite(root, 'review.eval.ts', {
    cases: [
      { id: 'inconclusive-activation', kind: 'activation' },
      { id: 'reads-result', kind: 'pass' },
      { id: 'wrong-result', kind: 'fail' },
    ],
    name: 'review-change',
  });
};
