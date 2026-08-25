import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks, chromeTimeToMs } from '../src/server/bookmarks-file.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'));

describe('parseBookmarks', () => {
  it('flattens every bookmark across all roots', () => {
    const index = parseBookmarks(fixture);
    expect(index.bookmarks).toHaveLength(7);
  });

  it('builds a human readable folder path', () => {
    const index = parseBookmarks(fixture);
    const rust = index.bookmarks.find(b => b.folderPath.endsWith('/Rust'));
    expect(rust?.folderPath).toBe('/Bookmarks bar/Dev/Rust');
  });

  it('counts folders recursively and directly', () => {
    const index = parseBookmarks(fixture);
    const dev = index.folders.find(f => f.title === 'Dev')!;
    expect(dev.bookmarkCount).toBe(2);
    expect(dev.totalCount).toBe(3);
  });

  it('indexes by id and guid', () => {
    const index = parseBookmarks(fixture);
    const first = index.bookmarks[0];
    expect(index.byId.get(first.id)).toBe(first);
    expect(index.byGuid.get(first.guid)).toBe(first);
  });

  it('preserves unicode titles', () => {
    const index = parseBookmarks(fixture);
    expect(index.bookmarks.some(b => b.title === 'Café résumé')).toBe(true);
  });

  it('records the parent id and sibling index of each bookmark', () => {
    const index = parseBookmarks(fixture);
    const book = index.bookmarks.find(b => b.title === 'The Book')!;
    expect(book.parentId).toBe('3');
    expect(book.index).toBe(0);
  });

  it('includes empty roots as folders', () => {
    const index = parseBookmarks(fixture);
    expect(index.folders.some(f => f.title === 'Mobile bookmarks')).toBe(true);
  });
});

describe('chromeTimeToMs', () => {
  it('converts the 1601 microsecond epoch to the unix millisecond epoch', () => {
    expect(chromeTimeToMs('13079403021286781')).toBe(1434929421286);
  });

  it('returns 0 for an empty value', () => {
    expect(chromeTimeToMs('')).toBe(0);
  });
});
