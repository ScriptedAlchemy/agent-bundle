import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { describe, expect, it } from '@rstest/core';

import {
  detectProcessTerminal,
  noTerminal,
  sharesOutputTarget,
  terminalColor,
  type TerminalStreamProbe,
} from '../src/terminal-capability.ts';

/** A descriptor number no process holds open: `fstat` on it fails with EBADF. */
const CLOSED_FD = 1_000_003;

const tty = (fd: number, columns = 120, rows = 40): TerminalStreamProbe => ({ columns, fd, isTTY: true, rows });

describe('terminal color detection (#511)', () => {
  it('follows the informal standards in their usual precedence', () => {
    const xterm = { TERM: 'xterm-256color' };
    // A terminal renders at the depth TERM/COLORTERM advertise; a pipe renders none.
    expect(terminalColor(xterm, true)).toBe('256');
    expect(terminalColor({ COLORTERM: 'truecolor', TERM: 'xterm' }, true)).toBe('truecolor');
    expect(terminalColor({ TERM: 'xterm' }, true)).toBe('basic');
    expect(terminalColor({}, true)).toBe('basic');
    expect(terminalColor(xterm, false)).toBe('none');
    // FORCE_COLOR decides outright, with Node's own reading of its value.
    expect(terminalColor({ ...xterm, FORCE_COLOR: '' }, false)).toBe('basic');
    expect(terminalColor({ ...xterm, FORCE_COLOR: '1' }, false)).toBe('basic');
    expect(terminalColor({ ...xterm, FORCE_COLOR: 'true' }, false)).toBe('basic');
    expect(terminalColor({ ...xterm, FORCE_COLOR: '2' }, false)).toBe('256');
    expect(terminalColor({ ...xterm, FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(terminalColor({ ...xterm, FORCE_COLOR: '0' }, true)).toBe('none');
    expect(terminalColor({ ...xterm, FORCE_COLOR: 'false' }, true)).toBe('none');
    // FORCE_COLOR beats NO_COLOR either way.
    expect(terminalColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, false)).toBe('basic');
    expect(terminalColor({ FORCE_COLOR: '0', NO_COLOR: '' }, true)).toBe('none');
    // CLICOLOR_FORCE forces color on for a pipe, at the advertised depth; NO_COLOR and CLICOLOR=0 force it off.
    expect(terminalColor({ ...xterm, CLICOLOR_FORCE: '1' }, false)).toBe('256');
    expect(terminalColor({ CLICOLOR_FORCE: '0', TERM: 'xterm' }, false)).toBe('none');
    expect(terminalColor({ ...xterm, NO_COLOR: '1' }, true)).toBe('none');
    expect(terminalColor({ ...xterm, NO_COLOR: '' }, true)).toBe('256');
    expect(terminalColor({ ...xterm, CLICOLOR: '0' }, true)).toBe('none');
    // A dumb terminal cannot render color.
    expect(terminalColor({ TERM: 'dumb' }, true)).toBe('none');
    expect(terminalColor({ CLICOLOR_FORCE: '1', TERM: 'dumb' }, false)).toBe('basic');
  });
});

describe('process terminal detection (#511)', () => {
  it('reports a terminal with its size and color, and lets COLUMNS/LINES override the size', () => {
    const env = { COLORTERM: 'truecolor', TERM: 'xterm-256color' };
    const probed = detectProcessTerminal('cli', { env, stderr: tty(2), stdout: tty(1) });
    expect(probed.hostSurface).toBe('cli');
    expect(probed.stdout).toEqual({ color: 'truecolor', columns: 120, kind: 'tty', rows: 40 });
    expect(probed.stderr).toEqual({ color: 'truecolor', columns: 120, kind: 'tty', rows: 40 });
    expect(Object.isFrozen(probed)).toBe(true);
    expect(Object.isFrozen(probed.stdout)).toBe(true);

    const overridden = detectProcessTerminal('script', { env: { ...env, COLUMNS: '200', LINES: '60' }, stderr: tty(2), stdout: tty(1) });
    expect(overridden.stdout).toMatchObject({ columns: 200, rows: 60 });
    expect(overridden.stderr).toMatchObject({ columns: 200, rows: 60 });
    // Garbage overrides are no override.
    const garbage = detectProcessTerminal('script', { env: { ...env, COLUMNS: 'wide', LINES: '0' }, stderr: tty(2), stdout: tty(1) });
    expect(garbage.stdout).toMatchObject({ columns: 120, rows: 40 });
  });

  it('reports any other open descriptor as a color-free pipe, sized only by an explicit override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-bundle-terminal-'));
    const fd = openSync(join(directory, 'out.log'), 'w');
    try {
      const env = { TERM: 'xterm-256color' };
      const piped = detectProcessTerminal('cli', {
        env,
        stderr: { columns: 80, fd, isTTY: false, rows: 24 },
        stdout: { columns: 80, fd, isTTY: false, rows: 24 },
      });
      expect(piped.stdout).toEqual({ color: 'none', kind: 'pipe' });
      expect(piped.stderr).toEqual({ color: 'none', kind: 'pipe' });
      // Both descriptors name one file: `2>&1` from inside the process.
      expect(piped.sharesTarget).toBe(true);

      const forced = detectProcessTerminal('cli', {
        env: { ...env, COLUMNS: '100', FORCE_COLOR: '3' },
        stderr: { fd, isTTY: false },
        stdout: { fd, isTTY: false },
      });
      expect(forced.stdout).toEqual({ color: 'truecolor', columns: 100, kind: 'pipe' });
    } finally {
      closeSync(fd);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('reports a closed descriptor as none and never colors it', () => {
    const closed = detectProcessTerminal('script', {
      env: { FORCE_COLOR: '3' },
      stderr: { fd: CLOSED_FD, isTTY: false },
      stdout: { fd: CLOSED_FD, isTTY: false },
    });
    expect(closed.stdout).toEqual({ color: 'none', kind: 'none' });
    expect(closed.stderr).toEqual({ color: 'none', kind: 'none' });
    expect(closed.sharesTarget).toBe(false);
    expect(sharesOutputTarget(CLOSED_FD, CLOSED_FD)).toBe(false);
  });

  it('probes this process by default', () => {
    const probed = detectProcessTerminal('cli');
    expect(probed.hostSurface).toBe('cli');
    // The test runner's streams are whatever they are; the shape is what is pinned.
    expect(['tty', 'pipe', 'none']).toContain(probed.stdout.kind);
    expect(['tty', 'pipe', 'none']).toContain(probed.stderr.kind);
    expect(typeof probed.sharesTarget).toBe('boolean');
  });
});

describe('terminal-free surfaces (#511)', () => {
  it('report none on both streams without probing anything', () => {
    for (const surface of ['mcp', 'hook', 'workbench'] as const) {
      expect(noTerminal(surface)).toEqual({
        hostSurface: surface,
        sharesTarget: false,
        stderr: { color: 'none', kind: 'none' },
        stdout: { color: 'none', kind: 'none' },
      });
      expect(Object.isFrozen(noTerminal(surface))).toBe(true);
    }
  });
});
