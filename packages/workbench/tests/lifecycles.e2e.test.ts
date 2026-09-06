import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { browserLaunchOptions, browserTrace, workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 30_000 * timeScale;

const e2e = test.extend({
  playwright: {
    launchOptions: browserLaunchOptions,
    contextOptions: { viewport: { height: 900, width: 1440 } },
    trace: browserTrace,
  } satisfies PlaywrightOptions,
});

e2e(
  'replays fixture and observed lifecycle receipts for Claude and Codex, then repairs stale manifest binding',
  { timeout: 180_000 },
  async ({ page }) => {
    const nodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const fixture = await startRuntimePlaygroundFixture();
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    try {
      await page.goto(workbenchUrl(fixture.url, '/routes/events/tool/after'));
      try {
        await expect(page.getByTestId('route-workspace')).toBeVisible({ timeout: browserTimeout });
      } catch (reason) {
        throw new Error(
          `Event route workspace did not become ready at ${page.url()}.\n${await page.locator('body').innerText()}`,
          { cause: reason },
        );
      }
      await expect(page.getByText(/Loading/u)).toHaveCount(0, { timeout: browserTimeout });
      await expect(page.getByTestId('workbench-nav').getByRole('link', { name: 'Application' })).toHaveAttribute('aria-current', 'page');

      const host = page.getByLabel('Event host');
      const editor = page.getByTestId('route-input-editor');
      const input = editor.locator('textarea');
      const fixtureSelector = editor.getByLabel('Fixture');
      const run = page.getByTestId('route-run');
      const stage = page.getByLabel('Rendered Agent Document');

      await host.getByRole('button', { name: 'Claude' }).click();
      await fixtureSelector.selectOption({ index: 1 });
      await expect(input).toHaveValue(/PostToolUse/u);
      await run.click();
      await expect(page.getByTestId('route-status')).toContainText('Completed', { timeout: browserTimeout });
      await expect(stage).toContainText(/Recorded .* from claude/u, { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Native in / out' }).click();
      await expect(page.getByRole('tabpanel')).toContainText('hookSpecificOutput');
      await expect(page.getByRole('tabpanel')).toContainText('additionalContext');

      await host.getByRole('button', { name: 'Codex' }).click();
      await fixtureSelector.selectOption({ index: 1 });
      await run.click();
      await expect(page.getByTestId('route-status')).toContainText('Completed', { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Rendered' }).click();
      await expect(stage).toContainText(/Recorded .* from codex/u, { timeout: browserTimeout });

      await page.getByRole('tab', { name: 'Replay' }).click();
      const replay = page.getByRole('tabpanel');
      await replay.getByLabel('Host').selectOption('claude');
      const observedReceipt = JSON.stringify({
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        session_id: 'lifecycle-observed',
        tool_input: { file_path: 'observed-lifecycle.txt' },
        tool_name: 'Write',
        tool_response: { success: true },
        tool_use_id: 'lifecycle-observed-write',
        transcript_path: '/tmp/lifecycle-observed-transcript.jsonl',
      });
      await replay.getByLabel('Native receipt (JSON)').fill(observedReceipt);
      await replay.getByRole('button', { name: 'Replay receipt' }).click();
      await expect(page.getByTestId('route-status')).toContainText('Completed', { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Rendered' }).click();
      await expect(stage).toContainText('Recorded observed-lifecycle.txt from claude', { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Canonical → host mapping' }).click();
      const requestContext = page.getByRole('tabpanel');
      await expect(requestContext).toContainText('claude · receipt');
      await expect(requestContext).toContainText('lifecycle-observed');
      await expect(requestContext).toContainText('/tmp');
      await expect(requestContext).toContainText('Unavailable · not-provided');
      await expect(requestContext).toContainText('lifecycle-observed · depth 0 · native · receipt');

      const sessionToken = await page.evaluate(async () => {
        const response = await fetch('/api/project/session', { credentials: 'same-origin' });
        const body: unknown = await response.json();
        if (!response.ok || typeof body !== 'object' || body === null || typeof (body as { readonly token?: unknown }).token !== 'string') {
          throw new Error(`Lifecycle session bootstrap failed with ${String(response.status)}.`);
        }
        return (body as { readonly token: string }).token;
      });
      const manifestDigest = async (): Promise<string> => page.evaluate(async (token) => {
        const response = await fetch('/api/lifecycles', {
          credentials: 'same-origin',
          headers: { 'x-agent-bundle-session': token },
        });
        const body: unknown = await response.json();
        if (!response.ok || typeof body !== 'object' || body === null || typeof (body as { readonly manifestDigest?: unknown }).manifestDigest !== 'string') {
          throw new Error(`Lifecycle list failed with ${String(response.status)}.`);
        }
        return (body as { readonly manifestDigest: string }).manifestDigest;
      }, sessionToken);
      const staleDigest = await manifestDigest();
      const eventSource = join(fixture.root, 'src', 'events', 'tool', 'after.tsx');
      const source = await readFile(eventSource, 'utf8');
      await replaceWatchedSource(fixture.root, eventSource, `${source}\n// lifecycle stale-repair ${Date.now()}\n`);
      await expect.poll(manifestDigest, { timeout: browserTimeout }).not.toBe(staleDigest);
      await expect.poll(
        () => page.evaluate(async () => {
          const response = await fetch('/api/project/status');
          const body = await response.json() as { status: { artifact: { state: string } } };
          return body.status.artifact.state;
        }),
        { timeout: browserTimeout },
      ).toBe('active');
      await page.goto(workbenchUrl(fixture.url, '/routes/events/tool/after'));
      await expect(page.getByTestId('route-status')).toContainText('Not run yet', { timeout: browserTimeout });

      await page.getByRole('tab', { name: 'Replay' }).click();
      const repairedReplay = page.getByRole('tabpanel');
      await repairedReplay.getByLabel('Host').selectOption('claude');
      await repairedReplay.getByLabel('Native receipt (JSON)').fill(observedReceipt);
      await repairedReplay.getByRole('button', { name: 'Replay receipt' }).click();
      await expect(page.getByTestId('route-status')).toContainText('Completed', { timeout: browserTimeout });
      await page.getByRole('tab', { name: 'Rendered' }).click();
      await expect(stage).toContainText('Recorded observed-lifecycle.txt from claude', { timeout: browserTimeout });
      expect(pageErrors).toEqual([]);
    } finally {
      await fixture.close();
      if (nodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = nodeEnv;
    }
  },
);
