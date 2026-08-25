import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCache, saveCache, textHash, embedTextOf } from '../src/server/search/semantic.js';
import type { BookmarkNode } from '../src/server/types.js';

const base: BookmarkNode = {
  id: '1',
  guid: 'g',
  title: 'Rust',
  url: 'https://x.com',
  parentId: '0',
  index: 0,
  folderPath: '/Bookmarks bar',
  dateAdded: 0
};

describe('embedding cache', () => {
  it('returns an empty cache when the file is missing', async () => {
    expect(await loadCache(join(tmpdir(), 'does-not-exist-cbm.json'))).toEqual({});
  });

  it('returns an empty cache when the file is corrupt rather than throwing', async () => {
    const path = join(tmpdir(), `cbm-corrupt-${process.pid}.json`);
    await saveCache(path, {} as never);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not json at all');
    expect(await loadCache(path)).toEqual({});
  });

  it('round trips', async () => {
    const path = join(tmpdir(), `cbm-cache-${process.pid}.json`);
    await saveCache(path, { g1: { hash: 'abc', vec: [1, 2] } });
    expect(await loadCache(path)).toEqual({ g1: { hash: 'abc', vec: [1, 2] } });
  });

  it('changes the hash when the title changes', () => {
    const renamed = { ...base, title: 'Rust Book' };
    expect(textHash(embedTextOf(base))).not.toBe(textHash(embedTextOf(renamed)));
  });

  it('changes the hash when the bookmark moves folder', () => {
    const moved = { ...base, folderPath: '/Bookmarks bar/Dev' };
    expect(textHash(embedTextOf(base))).not.toBe(textHash(embedTextOf(moved)));
  });

  it('keeps the hash stable when nothing embedded changed', () => {
    const sameTextDifferentId = { ...base, id: '999', dateAdded: 12345 };
    expect(textHash(embedTextOf(base))).toBe(textHash(embedTextOf(sameTextDifferentId)));
  });
});
