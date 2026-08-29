import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { startRuntimePlaygroundFixture } from '../tests/helpers/runtime-playground-fixture.ts';

const browserTimeout = 30_000 * timeScale;
/**
 * Hard ceiling for the whole capture, comfortably under the calling test's
 * 600s budget so a wedge fails HERE with the current phase on stderr instead
 * of as an opaque rstest timeout with no output at all.
 */
const captureDeadline = 480_000;
/** Budget for each cleanup step; a wedged dev-server close must not hold the process. */
const cleanupStepTimeout = 30_000;
const desktopViewport = Object.freeze({ height: 900, width: 1440 });

let currentPhase = 'parse-arguments';
/** Marks capture progress so the watchdog and failures can say where the run was. */
const phase = (name) => { currentPhase = name; };

const boundedStep = async (name, promise) => {
  let timer;
  const timedOut = Symbol(name);
  const outcome = await Promise.race([
    promise,
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(timedOut), cleanupStepTimeout); }),
  ]).finally(() => clearTimeout(timer));
  if (outcome === timedOut) throw new Error(`Capture cleanup step ${name} exceeded ${cleanupStepTimeout}ms.`);
  return outcome;
};
const outputFlags = Object.freeze([
  '--desktop',
  '--hmr-before',
  '--hmr-after',
  '--compile-error',
  '--recovered',
  '--evidence',
]);

let temporaryOutputSequence = 0;
const cleanupFailureSteps = new WeakMap();

const requiredPath = (value, flag) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${flag} requires a nonempty output path.`);
  return resolve(value);
};

const parseArguments = (argv) => {
  if (argv.length !== outputFlags.length * 2) {
    throw new Error(`Usage: node packages/workbench/scripts/capture-runtime-playground.mjs ${outputFlags.map((flag) => `${flag} <path>`).join(' ')}`);
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!outputFlags.includes(flag) || values.has(flag)) throw new Error('Capture output flags must be supplied exactly once.');
    values.set(flag, requiredPath(argv[index + 1], flag));
  }
  if (values.size !== outputFlags.length) throw new Error('Capture output flags must be supplied exactly once.');
  const paths = [...values.values()];
  if (new Set(paths).size !== paths.length) throw new Error('Capture output paths must be distinct.');
  return Object.freeze({
    compileError: values.get('--compile-error'),
    desktop: values.get('--desktop'),
    evidence: values.get('--evidence'),
    hmrAfter: values.get('--hmr-after'),
    hmrBefore: values.get('--hmr-before'),
    recovered: values.get('--recovered'),
  });
};

const temporaryOutput = (path) => {
  const extension = extname(path);
  return join(dirname(path), `.${basename(path, extension)}.${process.pid}.${temporaryOutputSequence += 1}.tmp${extension}`);
};

export const atomically = async (path, write) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryOutput(path);
  try {
    await write(temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const screenshot = (page, path) => atomically(path, async (temporary) => page.screenshot({ path: temporary }));

/**
 * Replaces a watched source atomically through a rename staged OUTSIDE the
 * watched project. An in-place write is truncate-then-append: the dev
 * compiler can start a compile off the truncation event, read incomplete
 * content, and then drop the append event because both operations land
 * within the same mtime tick, so the final content never compiles and the
 * expected generation never activates. The temp file lives in the project's
 * parent (same filesystem, never watched) so the rename into place is the
 * only event the watcher observes.
 */
const replaceWatchedSource = async (projectRoot, path, content) => {
  const temporary = join(projectRoot, '..', `.${basename(path)}.${process.pid}.${temporaryOutputSequence += 1}.tmp`);
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
};

const writeEvidence = (path, evidence) => atomically(path, async (temporary) => {
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
});

export const cleanupCaptureResources = async ({ browser, fixture, restores }) => {
  phase('cleanup');
  const settledRestores = await Promise.allSettled(
    restores.map(async (restore, index) => boundedStep(`restore-${index + 1}`, restore())),
  );
  const failedSteps = settledRestores.flatMap((result, index) => result.status === 'rejected' ? [`restore-${index + 1}`] : []);
  // Each close is bounded: a wedged dev-server or browser shutdown records a
  // cleanup failure instead of holding the process open until the caller's
  // test budget expires with no diagnostics.
  if (browser !== undefined) {
    try {
      await boundedStep('browser.close', browser.close());
    } catch {
      failedSteps.push('browser.close');
    }
  }
  if (fixture !== undefined) {
    try {
      await boundedStep('fixture.close', fixture.close());
    } catch {
      failedSteps.push('fixture.close');
    }
  }
  return Object.freeze({
    attemptedRestores: restores.length,
    failedSteps: Object.freeze(failedSteps),
  });
};

export const captureFailureAfterCleanup = (primaryFailure, cleanup) => {
  if (cleanup.failedSteps.length === 0) return primaryFailure;
  const failedSteps = Object.freeze(cleanup.failedSteps.filter((step) => /^(?:restore-[1-3]|browser\.close|fixture\.close)$/u.test(step)).slice(0, 5));
  const cleanupFailure = new Error(`Capture cleanup failed: ${failedSteps.join(', ')}.`);
  cleanupFailureSteps.set(cleanupFailure, failedSteps);
  if (primaryFailure === undefined) return cleanupFailure;
  return new AggregateError([primaryFailure, cleanupFailure], primaryFailure instanceof Error ? primaryFailure.message : 'Runtime capture failed.');
};

export const formatCaptureFailure = (failure) => {
  if (failure instanceof AggregateError && failure.errors.length === 2) {
    const [primaryFailure, cleanupFailure] = failure.errors;
    const failedSteps = cleanupFailure instanceof Error ? cleanupFailureSteps.get(cleanupFailure) : undefined;
    if (failedSteps !== undefined) {
      const primaryMessage = primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure);
      return `${primaryMessage}\nCapture cleanup failed: ${failedSteps.join(', ')}.`;
    }
  }
  return failure instanceof Error ? failure.message : String(failure);
};

const attributes = async (identity) => identity.evaluate((element) => Object.freeze(Object.fromEntries(
  [...element.attributes]
    .filter((attribute) => attribute.name.startsWith('data-runtime-'))
    .map((attribute) => [attribute.name, attribute.value]),
)));

const currentRunId = async (page) => {
  const selected = page.locator('[data-runtime-run-id]').filter({ has: page.locator('button[aria-pressed="true"]') });
  await selected.waitFor({ state: 'attached', timeout: browserTimeout });
  const runId = await selected.getAttribute('data-runtime-run-id');
  if (runId === null || runId === '') throw new Error('The selected Runtime history item omitted its immutable run id.');
  return runId;
};

const waitForNewGeneration = async (page, before) => {
  const handle = await page.waitForFunction(
    ({ expected, selector }) => {
      const value = globalThis.document.querySelector(selector)?.getAttribute('data-runtime-generation');
      return typeof value === 'string' && value !== '' && value !== expected ? value : false;
    },
    { expected: before, selector: '[data-runtime-provider-session]' },
    { timeout: browserTimeout },
  );
  return await handle.jsonValue();
};

const runtimeAppFrame = async (page, bootstrapUrl) => {
  for (const frame of page.frames()) {
    try {
      if (frame.parentFrame()?.url() !== bootstrapUrl) continue;
      const heading = frame.getByRole('heading', { name: 'Runtime edit timeline' });
      if (await heading.count() === 1 && await heading.isVisible()) return frame;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Frame was detached')) throw error;
    }
  }
  return undefined;
};

const waitForRuntimeAppReady = async (page, expectedRunId) => {
  const outerFrame = page.locator('.runtime-stage .mcp-app-preview iframe');
  await outerFrame.waitFor({ state: 'visible', timeout: browserTimeout });
  if (await currentRunId(page) !== expectedRunId) throw new Error('Runtime App preview no longer belongs to the selected immutable run.');
  let bootstrapUrl = await outerFrame.getAttribute('src');
  if (bootstrapUrl === null || !new globalThis.URL(bootstrapUrl).pathname.startsWith('/__agent_bundle_runtime/bootstrap/')) {
    throw new Error('Runtime App preview did not expose its binding-scoped bootstrap URL.');
  }
  const deadline = Date.now() + browserTimeout;
  while (Date.now() < deadline) {
    const currentBootstrapUrl = await outerFrame.getAttribute('src');
    if (currentBootstrapUrl === null || !new globalThis.URL(currentBootstrapUrl).pathname.startsWith('/__agent_bundle_runtime/bootstrap/')) {
      throw new Error('Runtime App preview lost its binding-scoped bootstrap URL.');
    }
    bootstrapUrl = currentBootstrapUrl;
    const frame = await runtimeAppFrame(page, bootstrapUrl);
    if (frame !== undefined && await outerFrame.getAttribute('src') === bootstrapUrl) return Object.freeze({ bootstrapUrl, frame, outerFrame });
    await page.waitForTimeout(100);
  }
  throw new Error('Runtime App opaque child did not report its initialized timeline heading.');
};

const showRuntimeApp = async (page, expectedRunId) => {
  const deadline = Date.now() + browserTimeout;
  let detachedError;
  while (Date.now() < deadline) {
    try {
      const ready = await waitForRuntimeAppReady(page, expectedRunId);
      await ready.outerFrame.scrollIntoViewIfNeeded();
      const heading = ready.frame.getByRole('heading', { name: 'Runtime edit timeline' });
      await heading.waitFor({ state: 'visible', timeout: browserTimeout });
      await heading.scrollIntoViewIfNeeded();
      if (await ready.outerFrame.isVisible() && await heading.isVisible()) return ready;
    } catch (error) {
      if (!(error instanceof Error) || (!error.message.includes('Frame was detached') && !error.message.includes('Target page, context or browser has been closed'))) {
        throw error;
      }
      detachedError = error;
    }
    await page.waitForTimeout(100);
  }
  throw detachedError ?? new Error('Runtime App did not remain visible for capture.');
};

const runtimeRunIds = async (page) => page.locator('[data-runtime-run-id]').evaluateAll((rows) => rows
  .map((row) => row.getAttribute('data-runtime-run-id'))
  .filter((id) => id !== null && id !== ''));

const selectRun = async (page, id) => {
  const rows = page.locator('[data-runtime-run-id]');
  const index = (await runtimeRunIds(page)).indexOf(id);
  if (index < 0) throw new Error('Runtime history omitted the requested immutable run.');
  await rows.nth(index).locator('button[aria-pressed]').click();
  await page.waitForFunction(
    ({ expected, selector }) => {
      const selected = [...globalThis.document.querySelectorAll(selector)]
        .find((row) => row.querySelector('button[aria-pressed="true"]') !== null);
      return selected?.getAttribute('data-runtime-run-id') === expected;
    },
    { expected: id, selector: '[data-runtime-run-id]' },
    { timeout: browserTimeout },
  );
};

const runSurface = async (page, id, input) => {
  const surface = page.getByLabel('Runtime surface');
  await surface.selectOption(id);
  if (id === 'mcp.render_edit_timeline') await page.getByLabel('Runtime target').selectOption('portable');
  await page.getByRole('radio', { name: 'Raw JSON' }).check();
  await page.locator('#runtime-input-raw').fill(JSON.stringify(input));
  const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
  const before = await history.count();
  const runIdsBefore = await runtimeRunIds(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction(
    ({ expected, selector }) => globalThis.document.querySelectorAll(selector).length > expected,
    { expected: before, selector: '[aria-label="Runtime run history"] ol > li' },
    { timeout: browserTimeout },
  );
  const runId = (await runtimeRunIds(page)).find((id) => !runIdsBefore.includes(id));
  if (runId === undefined) throw new Error('Runtime invocation did not create an immutable history entry.');
  return runId;
};

const assertOpaqueSandbox = async (frame) => {
  const isolation = await frame.evaluate(() => {
    const parentDom = (() => {
      try {
        void globalThis.window.parent.document.documentElement;
        return 'available';
      } catch {
        return 'blocked';
      }
    })();
    const storage = (() => {
      try {
        void globalThis.window.localStorage.length;
        return 'available';
      } catch {
        return 'blocked';
      }
    })();
    return Object.freeze({ origin: globalThis.window.origin, parentDom, storage });
  });
  return isolation.origin === 'null' && isolation.parentDom === 'blocked' && isolation.storage === 'blocked';
};

const boundedLayoutNumber = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error(`Runtime capture ${label} was not a bounded finite number.`);
  }
  return Math.round(value * 1000) / 1000;
};

const boundedVerticalBounds = (value, label) => {
  if (typeof value !== 'object' || value === null) throw new Error(`Runtime capture ${label} bounds were absent.`);
  const candidate = value;
  const top = boundedLayoutNumber(candidate.top, `${label} top`);
  const bottom = boundedLayoutNumber(candidate.bottom, `${label} bottom`);
  const viewportHeight = boundedLayoutNumber(candidate.viewportHeight, `${label} viewport height`);
  if (viewportHeight <= 0) throw new Error(`Runtime capture ${label} viewport height was not positive.`);
  return Object.freeze({ bottom, top, viewportHeight });
};

const captureCompileErrorLayout = async (page, generation) => {
  const layout = await page.evaluate(({ diagnosticsSelector, lastGoodText }) => {
    const diagnostics = globalThis.document.querySelector(diagnosticsSelector);
    const lastGood = [...globalThis.document.querySelectorAll('.runtime-stage-generation')]
      .find((element) => element.textContent?.includes(lastGoodText) === true);
    if (!(diagnostics instanceof globalThis.HTMLElement) || !(lastGood instanceof globalThis.HTMLElement)) {
      throw new Error('Runtime capture compile-error landmarks were absent.');
    }
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();
      return Object.freeze({ bottom: rect.bottom, top: rect.top, viewportHeight: globalThis.innerHeight });
    };
    const initialLastGood = bounds(lastGood);
    const initialDiagnostics = bounds(diagnostics);
    const unionTop = Math.min(initialLastGood.top, initialDiagnostics.top);
    const unionBottom = Math.max(initialLastGood.bottom, initialDiagnostics.bottom);
    if (unionBottom - unionTop > globalThis.innerHeight) {
      throw new Error('Runtime capture compile-error landmarks exceed the desktop viewport.');
    }
    const nextTop = unionTop < 0
      ? globalThis.scrollY + unionTop
      : unionBottom > globalThis.innerHeight
        ? globalThis.scrollY + unionBottom - globalThis.innerHeight
        : globalThis.scrollY;
    globalThis.scrollTo({ left: 0, top: Math.max(0, nextTop) });
    const visible = (element) => {
      const style = globalThis.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    return Object.freeze({
      diagnostics: bounds(diagnostics),
      diagnosticsVisible: visible(diagnostics),
      lastGood: bounds(lastGood),
      lastGoodVisible: visible(lastGood),
    });
  }, {
    diagnosticsSelector: '[aria-label="Runtime diagnostics evidence"]',
    lastGoodText: `Last good: ${generation}`,
  });
  const diagnostics = boundedVerticalBounds(layout.diagnostics, 'compile-error diagnostics');
  const lastGood = boundedVerticalBounds(layout.lastGood, 'compile-error last-good');
  const diagnosticsVisible = layout.diagnosticsVisible === true
    && diagnostics.top >= 0
    && diagnostics.bottom <= diagnostics.viewportHeight;
  const lastGoodVisible = layout.lastGoodVisible === true
    && lastGood.top >= 0
    && lastGood.bottom <= lastGood.viewportHeight;
  if (!diagnosticsVisible || !lastGoodVisible) {
    throw new Error('Runtime capture compile-error landmarks were outside the desktop viewport.');
  }
  return Object.freeze({ diagnostics, diagnosticsVisible, lastGood, lastGoodVisible });
};

const restore = async (projectRoot, path, contents) => {
  await replaceWatchedSource(projectRoot, path, contents);
  if (await readFile(path, 'utf8') !== contents) throw new Error(`Capture fixture did not restore ${basename(path)}.`);
};

const capture = async (outputs) => {
  let fixture;
  let originals = [];
  let browser;
  let primaryFailure;
  let evidence;
  try {
    phase('fixture-boot');
    fixture = await startRuntimePlaygroundFixture();
    originals = await Promise.all([
      readFile(fixture.serverComponentSource, 'utf8'),
      readFile(fixture.widgetAppSource, 'utf8'),
      readFile(fixture.appStyles, 'utf8'),
    ]);
    phase('browser-launch');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: desktopViewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    phase('initial-load');
    await page.goto(`${fixture.url}#runtime`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Runtime Playground' }).waitFor({ state: 'visible', timeout: browserTimeout });
    const identity = page.locator('[data-runtime-provider-session]');
    await identity.waitFor({ state: 'visible', timeout: browserTimeout });
    await page.waitForFunction(
      (selector) => globalThis.document.querySelector(selector)?.getAttribute('data-runtime-hmr-ready') === 'true',
      '[data-runtime-provider-session]',
      { timeout: browserTimeout },
    );
    const before = await attributes(identity);
    const providerSessionId = before['data-runtime-provider-session'];
    const generationBefore = before['data-runtime-generation'];
    if (providerSessionId === undefined || providerSessionId === '' || generationBefore === undefined || generationBefore === '') {
      throw new Error('Runtime identity omitted the provider session or generation.');
    }
    const documentTimeOriginBefore = await page.evaluate(() => globalThis.performance.timeOrigin);
    const documentMarker = 'runtime-capture-document';
    await page.evaluate((value) => { globalThis.document.documentElement.dataset.runtimeCaptureDocument = value; }, documentMarker);

    phase('first-run');
    const runBefore = await runSurface(page, 'mcp.render_edit_timeline', {});
    await selectRun(page, runBefore);
    await showRuntimeApp(page, runBefore);
    const appVisibleBefore = true;
    await screenshot(page, outputs.hmrBefore);

    const editedServer = originals[0].replace('Shared state now contains', 'Live runtime state now contains');
    if (editedServer === originals[0]) throw new Error('Capture fixture server source did not contain the expected HMR literal.');
    const repairedServer = editedServer.replace('Live runtime state now contains', 'Recovered runtime state now contains');
    if (repairedServer === editedServer) throw new Error('Capture fixture server source did not contain the expected repair literal.');
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    const historyBeforeHmr = await history.count();
    const runIdsBeforeHmr = await runtimeRunIds(page);
    phase('hmr-edit');
    await replaceWatchedSource(fixture.root, fixture.serverComponentSource, editedServer);
    const generationAfter = await waitForNewGeneration(page, generationBefore);
    await page.waitForFunction(
      ({ expected, selector }) => globalThis.document.querySelectorAll(selector).length > expected,
      { expected: historyBeforeHmr, selector: '[aria-label="Runtime run history"] ol > li' },
      { timeout: browserTimeout },
    );
    const runAfter = (await runtimeRunIds(page)).find((id) => !runIdsBeforeHmr.includes(id));
    if (runAfter === undefined || runAfter === runBefore) throw new Error('Runtime HMR did not create an immutable replay run.');
    await selectRun(page, runAfter);
    await showRuntimeApp(page, runAfter);
    const appVisibleAfter = true;
    await screenshot(page, outputs.hmrAfter);

    phase('compact-run');
    const compactRunId = await runSurface(page, 'mcp.recent_edits', {});
    await selectRun(page, compactRunId);
    await page.waitForFunction(
      (selector) => globalThis.document.querySelector(selector) === null,
      '.runtime-stage .mcp-app-preview iframe',
      { timeout: browserTimeout },
    );
    const compactRunGeneration = await identity.getAttribute('data-runtime-generation');
    if (compactRunGeneration === null || compactRunGeneration === '') {
      throw new Error('Runtime capture compact run omitted its generation.');
    }
    const lastGoodGenerationDuringError = compactRunGeneration;
    const historyBeforeError = await history.count();
    const eventSequenceBeforeError = Number((await attributes(identity))['data-runtime-event-sequence']);
    if (!Number.isFinite(eventSequenceBeforeError)) throw new Error('Runtime identity omitted its event sequence.');
    phase('compile-error');
    await replaceWatchedSource(fixture.root, fixture.serverComponentSource, `${editedServer}\nconst = ;\n`);
    await page.waitForFunction(
      ({ expected, selector }) => Number(globalThis.document.querySelector(selector)?.getAttribute('data-runtime-event-sequence')) > expected,
      { expected: eventSequenceBeforeError, selector: '[data-runtime-provider-session]' },
      { timeout: browserTimeout },
    );
    await page.waitForFunction(
      (selector) => {
        const announcements = globalThis.document.querySelectorAll(selector);
        return announcements[announcements.length - 1]?.textContent === 'Runtime generation failed. The last good result remains available.';
      },
      '.runtime-announcement[role="alert"]',
      { timeout: browserTimeout },
    );
    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
    const diagnostics = page.getByLabel('Runtime diagnostics evidence');
    await diagnostics.waitFor({ state: 'visible', timeout: browserTimeout });
    await page.waitForFunction(
      (selector) => globalThis.document.querySelector(selector)?.textContent?.includes('AB8206') === true,
      '[aria-label="Runtime diagnostics evidence"]',
      { timeout: browserTimeout },
    );
    const generationDuringError = await identity.getAttribute('data-runtime-generation');
    const retainedRun = await currentRunId(page);
    const compileErrorHistoryUnchanged = await history.count() === historyBeforeError;
    const lastGoodPreserved = generationDuringError === lastGoodGenerationDuringError
      && retainedRun === compactRunId
      && compileErrorHistoryUnchanged;
    if (!lastGoodPreserved) throw new Error('Runtime source-build failure did not retain the exact last-good run.');
    const compileErrorLayout = await captureCompileErrorLayout(page, compactRunGeneration);
    await screenshot(page, outputs.compileError);

    phase('recovery');
    await replaceWatchedSource(fixture.root, fixture.serverComponentSource, repairedServer);
    const generationRecovered = await waitForNewGeneration(page, lastGoodGenerationDuringError);
    await page.waitForFunction(
      ({ expected, selector }) => globalThis.document.querySelectorAll(selector).length > expected,
      { expected: historyBeforeError, selector: '[aria-label="Runtime run history"] ol > li' },
      { timeout: browserTimeout },
    );
    await page.waitForFunction(
      (selector) => globalThis.document.querySelector(selector)?.textContent?.includes('No provider diagnostics.') === true,
      '[aria-label="Runtime diagnostics evidence"]',
      { timeout: browserTimeout },
    );

    phase('app-refresh');
    const runWithApp = await runSurface(page, 'mcp.render_edit_timeline', {});
    if (runWithApp === runAfter) throw new Error('Runtime App capture did not create a fresh explicit run after recovery.');
    await selectRun(page, runWithApp);
    const readyApp = await showRuntimeApp(page, runWithApp);
    const appVisibleRecovered = true;
    await screenshot(page, outputs.recovered);
    const outerFrame = readyApp.outerFrame;
    const outerHandle = await outerFrame.elementHandle();
    if (outerHandle === null) throw new Error('Runtime App outer frame was unavailable.');
    const outerSource = await outerHandle.getAttribute('src');
    if (outerSource === null || outerSource === '') throw new Error('Runtime App outer frame did not expose its bootstrap source.');
    const outerMarker = 'runtime-capture-outer';
    await outerHandle.evaluate((element, value) => { element.setAttribute('data-runtime-capture-outer', value); }, outerMarker);
    const widgetMarker = 'Runtime capture App refresh';
    const editedWidget = originals[1].replace(
      '<h1>Runtime edit timeline</h1>',
      `<h1>Runtime edit timeline</h1><p data-testid="runtime-capture-marker">${widgetMarker}</p>`,
    );
    if (editedWidget === originals[1]) throw new Error('Capture fixture App source did not contain the expected heading.');
    const editedStyles = `${originals[2]}\n.timeline__header [data-testid="runtime-capture-marker"] { color: rgb(1, 2, 3); }\n`;
    await Promise.all([
      replaceWatchedSource(fixture.root, fixture.widgetAppSource, editedWidget),
      replaceWatchedSource(fixture.root, fixture.appStyles, editedStyles),
    ]);
    let appFrame;
    const deadline = Date.now() + browserTimeout;
    while (appFrame === undefined && Date.now() < deadline) {
      const bootstrapUrl = await outerFrame.getAttribute('src');
      appFrame = bootstrapUrl === null ? undefined : await runtimeAppFrame(page, bootstrapUrl);
      if (appFrame === undefined || await appFrame.getByTestId('runtime-capture-marker').count() === 0) {
        appFrame = undefined;
        await page.waitForTimeout(100);
      }
    }
    if (appFrame === undefined) throw new Error('Runtime App did not render the HMR capture marker.');
    const marker = appFrame.getByTestId('runtime-capture-marker');
    await marker.waitFor({ state: 'visible', timeout: browserTimeout });
    if (await marker.textContent() !== widgetMarker || await marker.evaluate((element) => globalThis.getComputedStyle(element).color) !== 'rgb(1, 2, 3)') {
      throw new Error('Runtime App did not apply its refreshed source and CSS.');
    }
    const appMarkerVisible = await marker.isVisible();
    if (!appMarkerVisible) throw new Error('Runtime App refresh marker was not visible.');
    const sandboxOpaqueOrigin = await assertOpaqueSandbox(appFrame);
    if (!sandboxOpaqueOrigin) throw new Error('Runtime App inner document did not remain opaque-origin isolated.');
    const documentTimeOriginAfter = await page.evaluate(() => globalThis.performance.timeOrigin);
    const appRefreshPreservedDocument = documentTimeOriginAfter === documentTimeOriginBefore
      && await page.evaluate((value) => globalThis.document.documentElement.dataset.runtimeCaptureDocument === value, documentMarker)
      && await outerHandle.evaluate((element, value) => element.isConnected
        && globalThis.document.querySelector('.runtime-stage .mcp-app-preview iframe') === element
        && element.getAttribute('data-runtime-capture-outer') === value, outerMarker)
      && await outerHandle.getAttribute('src') === outerSource;
    if (!appRefreshPreservedDocument) throw new Error('Runtime App refresh replaced the Workbench document or outer frame.');
    await outerFrame.scrollIntoViewIfNeeded();
    await marker.scrollIntoViewIfNeeded();
    const desktopControlColumns = await page.evaluate(() => {
      const controls = globalThis.document.querySelector('.runtime-controls');
      if (!(controls instanceof globalThis.HTMLElement)) throw new Error('Runtime capture desktop controls were absent.');
      const columns = globalThis.getComputedStyle(controls).gridTemplateColumns.trim();
      if (columns === '' || columns === 'none') return 0;
      return columns.split(/\s+/u).length;
    });
    if (desktopControlColumns !== 4) throw new Error(`Runtime capture expected four desktop control columns, received ${desktopControlColumns}.`);
    await screenshot(page, outputs.desktop);

    await Promise.all([
      restore(fixture.root, fixture.serverComponentSource, originals[0]),
      restore(fixture.root, fixture.widgetAppSource, originals[1]),
      restore(fixture.root, fixture.appStyles, originals[2]),
    ]);
    if (pageErrors.length > 0) throw new Error('Runtime capture encountered a browser page error.');
    evidence = Object.freeze({
      appMarkerVisible,
      appRefreshPreservedDocument,
      appVisibleAfter,
      appVisibleBefore,
      appVisibleRecovered,
      compactRunGeneration,
      compactRunId,
      compileErrorDiagnosticsVisible: compileErrorLayout.diagnosticsVisible,
      compileErrorGeneration: generationDuringError,
      compileErrorHistoryUnchanged,
      compileErrorLastGoodVisible: compileErrorLayout.lastGoodVisible,
      compileErrorLayout: Object.freeze({
        diagnostics: compileErrorLayout.diagnostics,
        lastGood: compileErrorLayout.lastGood,
      }),
      compileErrorRunId: retainedRun,
      documentTimeOriginAfter,
      documentTimeOriginBefore,
      desktopControlColumns,
      generationAfter,
      generationBefore,
      generationRecovered,
      hmrWithoutReload: documentTimeOriginAfter === documentTimeOriginBefore,
      lastGoodGenerationDuringError,
      lastGoodPreserved,
      providerSessionId,
      recovered: generationRecovered !== lastGoodGenerationDuringError,
      runAfter,
      runBefore,
      sandboxOpaqueOrigin,
      viewports: Object.freeze({ desktop: desktopViewport }),
    });
    phase('evidence-write');
    await writeEvidence(outputs.evidence, evidence);
  } catch (error) {
    primaryFailure = error;
  }
  const cleanup = await cleanupCaptureResources({
    browser,
    fixture,
    restores: fixture === undefined || originals.length !== 3 ? [] : [
      () => restore(fixture.root, fixture.serverComponentSource, originals[0]),
      () => restore(fixture.root, fixture.widgetAppSource, originals[1]),
      () => restore(fixture.root, fixture.appStyles, originals[2]),
    ],
  });
  const failure = captureFailureAfterCleanup(primaryFailure, cleanup);
  if (failure !== undefined) throw failure;
  return evidence;
};

const run = async () => {
  const outputs = parseArguments(process.argv.slice(2));
  const evidence = await capture(outputs);
  await new Promise((resolveWrite) => process.stdout.write(`${JSON.stringify(evidence)}\n`, resolveWrite));
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Watchdog: if anything wedges (fixture boot, a browser wait, cleanup),
  // fail loudly with the phase that hung instead of letting the calling
  // test's whole budget expire with no output. unref() keeps the timer from
  // holding an otherwise finished process open.
  const watchdog = setTimeout(() => {
    process.stderr.write(
      `Runtime capture watchdog fired after ${captureDeadline}ms during phase ${currentPhase}.\n`,
      () => process.exit(1),
    );
  }, captureDeadline);
  watchdog.unref();
  run().then(
    // Force the exit: a lingering handle (a wedged child process or socket
    // surviving a bounded-but-failed cleanup) must not keep the process
    // alive after the capture itself has settled.
    () => process.exit(0),
    (error) => {
      process.stderr.write(
        `${formatCaptureFailure(error)}\nLast capture phase: ${currentPhase}.\n`,
        () => process.exit(1),
      );
    },
  );
}
