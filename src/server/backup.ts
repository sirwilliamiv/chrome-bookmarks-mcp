import { copyFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { statePath, stateDir } from './paths.js';
import { mkdirSync } from 'node:fs';

export function backupsDir(): string {
  const dir = join(stateDir(), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Copies the live Bookmarks file aside and returns the backup path. */
export async function snapshot(bookmarksPath: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const target = join(backupsDir(), `${stamp}.json`);
  await copyFile(bookmarksPath, target);
  return target;
}

export async function pruneBackups(keep = 20): Promise<void> {
  const dir = backupsDir();
  const entries = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  const excess = entries.slice(0, Math.max(0, entries.length - keep));
  await Promise.all(excess.map(name => unlink(join(dir, name)).catch(() => {})));
}

export function lastBatchPath(): string {
  return statePath('last-batch.json');
}
