import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cbm-home-'));
process.env.CHROME_BOOKMARKS_MCP_HOME = home;

const { snapshot, pruneBackups, backupsDir } = await import('../src/server/backup.js');

describe('snapshot', () => {
  it('copies the bookmarks file into the backups dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-src-'));
    const src = join(dir, 'Bookmarks');
    writeFileSync(src, '{"roots":{}}');
    const out = await snapshot(src);
    expect(readFileSync(out, 'utf8')).toBe('{"roots":{}}');
  });

  it('writes into the state home, not next to the original', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-src-'));
    const src = join(dir, 'Bookmarks');
    writeFileSync(src, '{}');
    expect(await snapshot(src)).toContain(home);
  });
});

describe('pruneBackups', () => {
  beforeEach(() => {
    mkdirSync(backupsDir(), { recursive: true });
    // start from an empty dir so snapshots written by the tests above do not
    // count toward the keep limit
    for (const name of readdirSync(backupsDir())) {
      rmSync(join(backupsDir(), name), { force: true });
    }
  });

  it('keeps only the newest N backups', async () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(backupsDir(), `2020-01-0${i}T00-00-00.000Z.json`), '{}');
    }
    await pruneBackups(3);
    const remaining = readdirSync(backupsDir()).filter(n => n.startsWith('2020-'));
    expect(remaining).toHaveLength(3);
    expect(remaining.sort()[0]).toBe('2020-01-05T00-00-00.000Z.json');
  });
});
