import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);

export async function setup(): Promise<void> {
  await execFile('npm', ['run', 'build'], { cwd: process.cwd() });
}
