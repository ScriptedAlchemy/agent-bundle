import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@rstest/core';

// @ts-expect-error The executable capture script is intentionally imported as the cleanup-boundary test seam.
import { atomically, cleanupCaptureResources, captureFailureAfterCleanup, formatCaptureFailure } from '../scripts/capture-runtime-playground.mjs';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const captureScript = join(workspaceRoot, 'packages', 'workbench', 'scripts', 'capture-runtime-playground.mjs');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type HorizontalBounds = Readonly<{
  readonly left: number;
  readonly right: number;
  readonly viewportWidth: number;
}>;

type VerticalBounds = Readonly<{
  readonly bottom: number;
  readonly top: number;
  readonly viewportHeight: number;
}>;

type CaptureEvidence = Readonly<{
  readonly appMarkerVisible: boolean;
  readonly appRefreshPreservedDocument: boolean;
  readonly appVisibleAfter: boolean;
  readonly appVisibleBefore: boolean;
  readonly appVisibleRecovered: boolean;
  readonly compactRunGeneration: string;
  readonly compactRunId: string;
  readonly compileErrorDiagnosticsVisible: boolean;
  readonly compileErrorGeneration: string;
  readonly compileErrorHistoryUnchanged: boolean;
  readonly compileErrorLastGoodVisible: boolean;
  readonly compileErrorLayout: Readonly<{
    readonly diagnostics: VerticalBounds;
    readonly lastGood: VerticalBounds;
  }>;
  readonly compileErrorRunId: string;
  readonly documentTimeOriginAfter: number;
  readonly documentTimeOriginBefore: number;
  readonly desktopControlColumns: number;
  readonly generationAfter: string;
  readonly generationBefore: string;
  readonly generationRecovered: string;
  readonly hmrWithoutReload: boolean;
  readonly lastGoodGenerationDuringError: string;
  readonly lastGoodPreserved: boolean;
  readonly mobileLayout: Readonly<{
    readonly bodyScrollLeft: number;
    readonly childHeading: HorizontalBounds;
    readonly childHeadingWithinViewport: boolean;
    readonly childMarker: HorizontalBounds;
    readonly childMarkerWithinViewport: boolean;
    readonly childScrollX: number;
    readonly documentScrollLeft: number;
    readonly controls: HorizontalBounds;
    readonly controlsWithinViewport: boolean;
    readonly host: HorizontalBounds;
    readonly hostWithinViewport: boolean;
    readonly hostScrollerScrollLefts: readonly number[];
    readonly outerFrame: HorizontalBounds;
    readonly outerFrameWithinViewport: boolean;
    readonly playground: HorizontalBounds;
    readonly playgroundWithinViewport: boolean;
    readonly stage: HorizontalBounds;
    readonly stageWithinViewport: boolean;
    readonly windowScrollX: number;
  }>;
  readonly mobileWithoutHorizontalOverflow: boolean;
  readonly providerSessionId: string;
  readonly recovered: boolean;
  readonly runAfter: string;
  readonly runBefore: string;
  readonly sandboxOpaqueOrigin: boolean;
  readonly viewports: Readonly<{
    readonly desktop: Readonly<{ readonly height: number; readonly width: number }>;
    readonly mobile: Readonly<{ readonly height: number; readonly width: number }>;
  }>;
}>;

const expectPng = async (path: string, width: number, height: number): Promise<void> => {
  const [contents, details] = await Promise.all([readFile(path), stat(path)]);
  expect(details.size).toBeGreaterThan(pngSignature.length);
  expect(contents.subarray(0, pngSignature.length)).toEqual(pngSignature);
  expect(contents.readUInt32BE(16)).toBe(width);
  expect(contents.readUInt32BE(20)).toBe(height);
};

test('settles every capture cleanup action without masking the primary failure', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-capture-cleanup-'));
  const temporary = join(outputRoot, '.desktop.png.temporary');
  const primary = new Error('primary capture failed');
  const order: string[] = [];
  let fixtureCloseCount = 0;
  try {
    await expect(atomically(temporary, async (path: string) => {
      await writeFile(path, 'partial output', 'utf8');
      throw primary;
    })).rejects.toBe(primary);

    const cleanup = await cleanupCaptureResources({
      browser: {
        close: async () => {
          order.push('browser.close');
          throw new Error('browser close rejected');
        },
      },
      fixture: {
        close: async () => {
          fixtureCloseCount += 1;
          order.push('fixture.close');
          throw new Error('fixture close rejected with fixture-secret');
        },
      },
      restores: [
        async () => {
          order.push('restore-one');
          throw new Error('restore one rejected');
        },
        async () => {
          order.push('restore-two');
        },
      ],
    });

    expect(order).toEqual(['restore-one', 'restore-two', 'browser.close', 'fixture.close']);
    expect(fixtureCloseCount).toBe(1);
    expect(cleanup).toEqual({ attemptedRestores: 2, failedSteps: ['restore-1', 'browser.close', 'fixture.close'] });
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });

    const failure = captureFailureAfterCleanup(primary, cleanup);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: 'primary capture failed' });
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors[1]).toMatchObject({ message: 'Capture cleanup failed: restore-1, browser.close, fixture.close.' });
    const formatted = formatCaptureFailure(failure);
    expect(formatted).toBe('primary capture failed\nCapture cleanup failed: restore-1, browser.close, fixture.close.');
    expect(formatted).not.toContain('restore one rejected');
    expect(formatted).not.toContain('browser close rejected');
    expect(formatted).not.toContain('fixture-secret');
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

test('captures identity-backed HMR, last-good, recovery, and responsive browser evidence', { timeout: 300_000 }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-capture-'));
  const outputs = Object.freeze({
    compileError: join(outputRoot, 'compile-error.png'),
    desktop: join(outputRoot, 'desktop.png'),
    evidence: join(outputRoot, 'evidence.json'),
    hmrAfter: join(outputRoot, 'hmr-after.png'),
    hmrBefore: join(outputRoot, 'hmr-before.png'),
    mobile: join(outputRoot, 'mobile.png'),
    recovered: join(outputRoot, 'recovered.png'),
  });
  try {
    const { stdout } = await execFile(process.execPath, [captureScript,
      '--desktop', outputs.desktop,
      '--mobile', outputs.mobile,
      '--hmr-before', outputs.hmrBefore,
      '--hmr-after', outputs.hmrAfter,
      '--compile-error', outputs.compileError,
      '--recovered', outputs.recovered,
      '--evidence', outputs.evidence,
    ], { cwd: workspaceRoot, timeout: 270_000 });

    await Promise.all([
      expectPng(outputs.desktop, 1440, 900),
      expectPng(outputs.mobile, 390, 844),
      expectPng(outputs.hmrBefore, 1440, 900),
      expectPng(outputs.hmrAfter, 1440, 900),
      expectPng(outputs.compileError, 1440, 900),
      expectPng(outputs.recovered, 1440, 900),
    ]);
    expect((await readdir(outputRoot)).sort()).toEqual([
      'compile-error.png',
      'desktop.png',
      'evidence.json',
      'hmr-after.png',
      'hmr-before.png',
      'mobile.png',
      'recovered.png',
    ]);

    const evidence = JSON.parse(await readFile(outputs.evidence, 'utf8')) as CaptureEvidence;
    const cliEvidence = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? '');
    expect(cliEvidence).toMatchObject({
      appVisibleAfter: true,
      appVisibleBefore: true,
      appVisibleRecovered: true,
      hmrWithoutReload: true,
      sandboxOpaqueOrigin: true,
    });
    expect(evidence).toMatchObject({
      appMarkerVisible: true,
      appRefreshPreservedDocument: true,
      appVisibleAfter: true,
      appVisibleBefore: true,
      appVisibleRecovered: true,
      compileErrorDiagnosticsVisible: true,
      compileErrorHistoryUnchanged: true,
      compileErrorLastGoodVisible: true,
      desktopControlColumns: 4,
      hmrWithoutReload: true,
      lastGoodPreserved: true,
      mobileLayout: {
        bodyScrollLeft: 0,
        childHeadingWithinViewport: true,
        childMarkerWithinViewport: true,
        childScrollX: 0,
        controlsWithinViewport: true,
        documentScrollLeft: 0,
        hostWithinViewport: true,
        outerFrameWithinViewport: true,
        playgroundWithinViewport: true,
        stageWithinViewport: true,
        windowScrollX: 0,
      },
      mobileWithoutHorizontalOverflow: true,
      recovered: true,
      sandboxOpaqueOrigin: true,
      viewports: {
        desktop: { height: 900, width: 1440 },
        mobile: { height: 844, width: 390 },
      },
    });
    expect(evidence.mobileLayout.hostScrollerScrollLefts.every((value) => value === 0)).toBe(true);
    for (const bounds of [
      evidence.mobileLayout.host,
      evidence.mobileLayout.playground,
      evidence.mobileLayout.controls,
      evidence.mobileLayout.stage,
      evidence.mobileLayout.outerFrame,
      evidence.mobileLayout.childHeading,
      evidence.mobileLayout.childMarker,
    ]) {
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.viewportWidth).toBeGreaterThan(0);
    }
    expect(evidence.providerSessionId).toEqual(expect.any(String));
    expect(evidence.providerSessionId.length).toBeGreaterThan(0);
    expect(evidence.compactRunId).toEqual(expect.any(String));
    expect(evidence.compactRunGeneration).toEqual(expect.any(String));
    expect(evidence.compileErrorRunId).toBe(evidence.compactRunId);
    expect(evidence.compileErrorGeneration).toBe(evidence.compactRunGeneration);
    for (const bounds of [evidence.compileErrorLayout.lastGood, evidence.compileErrorLayout.diagnostics]) {
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
      expect(bounds.viewportHeight).toBeGreaterThan(0);
    }
    expect(evidence.generationAfter).not.toBe(evidence.generationBefore);
    expect(evidence.runAfter).not.toBe(evidence.runBefore);
    expect(evidence.documentTimeOriginAfter).toBe(evidence.documentTimeOriginBefore);
    expect(evidence.generationRecovered).not.toBe(evidence.lastGoodGenerationDuringError);
    expect(JSON.stringify(evidence)).not.toContain(outputRoot);
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});
