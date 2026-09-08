import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../../agent-bundle/src/adapters/registry.ts';
import { installHost } from '../../agent-bundle/src/install/commands.ts';
import {
  hostCatalog,
  helpText,
  installableTargets,
  resolveOptions,
  targetNames,
  templateNames,
  UsageError,
  type Prompter,
} from '../src/options.ts';

/**
 * The scaffolder cannot load the compiler, so its host catalog restates two
 * `agent-bundle` facts: which targets `createDefaultRegistry` publishes and
 * which of them `install` accepts. #729 shipped the `amp` adapter while
 * `--targets amp` still failed at project creation (#745); these assertions
 * fail instead the next time an adapter lands without its scaffolder entry.
 */
const unusedPrompter: Prompter = {
  multiselect: () => { throw new Error('multiselect must not be prompted'); },
  select: () => { throw new Error('select must not be prompted'); },
  text: () => { throw new Error('text must not be prompted'); },
};

const scripted = (template: string, targets: readonly string[]): Promise<unknown> =>
  resolveOptions(
    { directory: 'plugin', help: false, install: false, targets: targets as never, template: template as never },
    { interactive: false, prompter: unusedPrompter, userAgent: undefined },
  );

it('offers exactly the built-in targets the compiler registers', () => {
  expect([...targetNames].sort()).toEqual([...createDefaultRegistry().names()].sort());
});

it('marks a target installable exactly when `install` accepts it as a host', () => {
  for (const target of targetNames) {
    let accepted = true;
    try {
      installHost(target);
    } catch {
      accepted = false;
    }
    expect(hostCatalog[target].installable).toBe(accepted);
  }
  expect(installableTargets).not.toContain('portable');
});

it('names a real template in every refusal, and explains it in the help text', () => {
  for (const target of targetNames) {
    for (const [template, reason] of Object.entries(hostCatalog[target].refusedTemplates)) {
      expect(templateNames).toContain(template);
      expect(reason).not.toBe('');
      expect(helpText).toContain(`${target} is not available for the ${template} template`);
    }
  }
});

it('refuses a scripted target the selected template cannot carry', async () => {
  // Amp's skill-scoped MCP contract refuses the mcp-server template's
  // compiler-owned local server: `agent-bundle validate --target amp` over that
  // template reports amp.mcp.generated-local.
  await expect(scripted('mcp-server', ['amp'])).rejects.toThrow(UsageError);
  await expect(scripted('mcp-server', ['portable', 'amp'])).rejects.toThrow(
    'Target "amp" cannot be scaffolded from the mcp-server template',
  );
  await expect(scripted('minimal', ['amp'])).resolves.toMatchObject({ targets: ['amp'], template: 'minimal' });
  await expect(scripted('cli-tool', ['amp'])).resolves.toMatchObject({ targets: ['amp'] });
});

it('names the templates a refused target can still use', async () => {
  await expect(scripted('mcp-server', ['amp'])).rejects.toThrow('Templates for amp: minimal, or cli-tool');
});
