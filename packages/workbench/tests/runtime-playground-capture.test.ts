import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const captureScript = join(workspaceRoot, 'packages', 'workbench', 'scripts', 'capture-runtime-playground.mjs');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  readonly providerSessionId: string;
  readonly recovered: boolean;
  readonly runAfter: string;
  readonly runBefore: string;
  readonly sandboxOpaqueOrigin: boolean;
  readonly viewports: Readonly<{
    readonly desktop: Readonly<{ readonly height: number; readonly width: number }>;
  }>;
}>;

const expectPng = async (path: string, width: number, height: number): Promise<void> => {
  const [contents, details] = await Promise.all([readFile(path), stat(path)]);
  expect(details.size).toBeGreaterThan(pngSignature.length);
  expect(contents.subarray(0, pngSignature.length)).toEqual(pngSignature);
  expect(contents.readUInt32BE(16)).toBe(width);
  expect(contents.readUInt32BE(20)).toBe(height);
};

test('captures identity-backed HMR, last-good, recovery, and desktop browser evidence', { timeout: 600_000 }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-capture-'));
  const outputs = Object.freeze({
    compileError: join(outputRoot, 'compile-error.png'),
    desktop: join(outputRoot, 'desktop.png'),
    evidence: join(outputRoot, 'evidence.json'),
    hmrAfter: join(outputRoot, 'hmr-after.png'),
    hmrBefore: join(outputRoot, 'hmr-before.png'),
    recovered: join(outputRoot, 'recovered.png'),
  });
  try {
    const { stdout } = await execFile(process.execPath, [captureScript,
      '--desktop', outputs.desktop,
      '--hmr-before', outputs.hmrBefore,
      '--hmr-after', outputs.hmrAfter,
      '--compile-error', outputs.compileError,
      '--recovered', outputs.recovered,
      '--evidence', outputs.evidence,
    ], { cwd: workspaceRoot });

    await Promise.all([
      expectPng(outputs.desktop, 1440, 900),
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
      recovered: true,
      sandboxOpaqueOrigin: true,
      viewports: {
        desktop: { height: 900, width: 1440 },
      },
    });
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
