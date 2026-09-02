import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 30_000 * timeScale;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

e2e(
  'replays fixture and observed lifecycle receipts for Claude and Codex, then repairs stale manifest binding',
  { timeout: 180_000 },
  async ({ page }) => {
    const fixture = await startRuntimePlaygroundFixture();
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    try {
      await page.goto(workbenchUrl(fixture.url, 'lifecycles'));
      try {
        await expect(page.getByRole('heading', { name: 'Lifecycles' })).toBeVisible({ timeout: browserTimeout });
      } catch (reason) {
        throw new Error(
          `Lifecycle page did not become ready at ${page.url()}.\n${await page.locator('body').innerText()}`,
          { cause: reason },
        );
      }
      await expect(page.getByText(/Loading semantic lifecycles/u)).toHaveCount(0, { timeout: browserTimeout });
      await expect(page.getByRole('link', { exact: true, name: 'Lifecycles' })).toHaveAttribute('aria-current', 'page');

      const selector = page.getByLabel('Lifecycle and target');
      const input = page.locator('#lifecycle-native-input');
      const run = page.getByRole('button', { name: 'Run replay' });
      const provenance = page.getByLabel('Replay provenance');
      const stage = page.getByLabel('Agent Document', { exact: true });
      const timeline = page.getByLabel('Agent Document event timeline');

      await selector.selectOption('claude/event:tool/after');
      await expect(input).toHaveValue(/PostToolUse/u);
      await run.click();
      await expect(provenance).toContainText('Fixture', { timeout: browserTimeout });
      await expect(provenance).toContainText('not evidence that claude dispatched this event');
      await expect(page.getByText('claude', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('PostToolUse', { exact: true }).first()).toBeVisible();
      await expect(stage).toContainText(/Recorded .* from claude/u, { timeout: browserTimeout });
      await expect(timeline.getByRole('button', { name: /^Complete/u })).toBeVisible({ timeout: browserTimeout });
      await expect(page.locator('.lifecycle-detail').filter({ hasText: 'Native response' })).toContainText('hookSpecificOutput');
      await expect(page.locator('.lifecycle-detail').filter({ hasText: 'Native response' })).toContainText('additionalContext');

      await selector.selectOption('codex/event:tool/after');
      await run.click();
      await expect(provenance).toContainText('Fixture', { timeout: browserTimeout });
      await expect(provenance).toContainText('not evidence that codex dispatched this event');
      await expect(page.getByText('codex', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('PostToolUse', { exact: true }).first()).toBeVisible();
      await expect(stage).toContainText(/Recorded .* from codex/u, { timeout: browserTimeout });

      await selector.selectOption('claude/event:tool/after');
      await page.getByRole('radio', { name: 'Observed native receipt' }).check();
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
      await input.fill(observedReceipt);
      await run.click();
      await expect(provenance).toContainText('Observed', { timeout: browserTimeout });
      await expect(stage).toContainText('Recorded observed-lifecycle.txt from claude', { timeout: browserTimeout });

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

      await run.click();
      await expect(page.getByRole('heading', { name: 'Stale compiled manifest' })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByText(/compiled manifest changed|manifest.*stale/iu)).toBeVisible({ timeout: browserTimeout });
      await page.getByRole('button', { name: 'Refresh lifecycle list' }).click();
      await expect(page.getByText(/run replay explicitly against the current manifest/u)).toBeVisible({ timeout: browserTimeout });
      await expect(input).toHaveValue(observedReceipt);
      await run.click();
      await expect(provenance).toContainText('Observed', { timeout: browserTimeout });
      await expect(stage).toContainText('Recorded observed-lifecycle.txt from claude', { timeout: browserTimeout });
      expect(pageErrors).toEqual([]);
    } finally {
      await fixture.close();
    }
  },
);
