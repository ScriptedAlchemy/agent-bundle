import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect } from '@rstest/playwright';
import type { Page, Request } from 'playwright-core';

import { workspaceRoot } from './workbench-e2e.ts';
import { timeScale } from '../../../agent-bundle/tests/support/time-scale.ts';

export type ExampleName = 'audiobook-curator' | 'hooks-and-scripts' | 'mcp-app' | 'skills-starter';

export interface ExampleCapture {
  readonly example: ExampleName;
  readonly file: string;
  readonly hash: string;
  readonly state: string;
  readonly viewport: { readonly height: 900; readonly width: 1440 };
}

interface FailedRequest {
  readonly error: string;
  readonly request: Request;
}

interface BrowserConsoleError {
  readonly text: string;
  readonly url: string;
}

export interface ExampleErrorLedger {
  readonly consoleErrors: BrowserConsoleError[];
  readonly failedRequests: FailedRequest[];
  readonly origin: string;
  readonly pageErrors: string[];
}

const browserTimeout = 15_000 * timeScale;
const captureRoot = process.env['AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR'];
const captures: ExampleCapture[] = [];

export const exampleRoot = (name: ExampleName): string => join(workspaceRoot, 'examples', name);

export const copyExample = async (name: ExampleName): Promise<{ readonly release: () => Promise<void>; readonly root: string }> => {
  const temporaryParent = join(workspaceRoot, '.agent-bundle');
  await mkdir(temporaryParent, { recursive: true });
  const root = await mkdtemp(join(temporaryParent, `${name}-e2e-`));
  const exampleSource = exampleRoot(name);
  await cp(exampleSource, root, {
    filter: (source) => !['.agent-bundle', 'dist', 'node_modules'].includes(basename(source)),
    recursive: true,
  });
  await symlink(join(exampleSource, 'node_modules'), join(root, 'node_modules'), 'dir');
  return { release: () => rm(root, { force: true, recursive: true }), root };
};

export const waitForSettledWorkbench = async (page: Page): Promise<void> => {
  await expect(page.getByText('Foreground server connected', { exact: true })).toBeVisible({ timeout: browserTimeout });
  await expect(page.locator('.loading-state')).toHaveCount(0, { timeout: browserTimeout });
  await expect(page.getByText(/^Loading(?:\s|…|$)/u)).toHaveCount(0, { timeout: browserTimeout });
};

export const captureExampleState = async (page: Page, example: ExampleName, state: string): Promise<void> => {
  await waitForSettledWorkbench(page);
  const viewport = page.viewportSize();
  if (viewport?.width !== 1440 || viewport.height !== 900) {
    throw new Error(`Expected a 1440×900 desktop capture, received ${viewport === null ? 'an unbounded viewport' : `${viewport.width}×${viewport.height}`}.`);
  }
  if (captureRoot === undefined) return;
  await mkdir(captureRoot, { recursive: true });
  const file = `${example}-${state}.png`;
  await page.screenshot({ animations: 'disabled', path: join(captureRoot, file) });
  captures.push({ example, file, hash: new URL(page.url()).hash, state, viewport: { height: 900, width: 1440 } });
};

export const writeExampleReport = async (): Promise<void> => {
  if (captureRoot === undefined) return;
  const names = new Set<string>();
  for (const capture of captures) {
    if (names.has(capture.file)) throw new Error(`Example capture filename was reused: ${capture.file}`);
    names.add(capture.file);
  }
  await writeFile(join(captureRoot, 'report.json'), `${JSON.stringify({ captures }, undefined, 2)}\n`);
};

export const createExampleErrorLedger = (page: Page, origin: string): ExampleErrorLedger => {
  const ledger: ExampleErrorLedger = { consoleErrors: [], failedRequests: [], origin, pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') ledger.consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('pageerror', (error) => ledger.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    ledger.failedRequests.push({ error: request.failure()?.errorText ?? 'unknown request failure', request });
  });
  return ledger;
};

const allowedUnmountCancellation = ({ error, request }: FailedRequest, origin: string): boolean => {
  if (error !== 'net::ERR_ABORTED' || request.method() !== 'GET') return false;
  const url = new URL(request.url());
  if (url.origin !== origin) return false;
  if (url.pathname === '/api/hooks') {
    const buildId = url.searchParams.get('epochId');
    return [...url.searchParams.keys()].length === 1
      && typeof buildId === 'string'
      && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(buildId);
  }
  return url.pathname === '/api/logs/stream'
    || url.pathname === '/api/logs/replay'
    || /^\/api\/evals\/runs\/[^/]+\/(?:events|stream)$/u.test(url.pathname)
    || /^\/api\/mcp\/sessions\/[^/]+\/stream$/u.test(url.pathname)
    || /^\/api\/playground\/sessions\/[^/]+\/(?:replay|stream)$/u.test(url.pathname);
};

export const expectHealthyExamplePage = async (ledger: ExampleErrorLedger): Promise<void> => {
  assert.deepEqual(ledger.pageErrors, []);
  assert.deepEqual(ledger.consoleErrors, []);
  const unexpectedFailures = ledger.failedRequests.filter((failure) => !allowedUnmountCancellation(failure, ledger.origin));
  assert.deepEqual(unexpectedFailures.map(({ error, request }) => ({ error, method: request.method(), url: request.url() })), []);
};
