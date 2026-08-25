import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { folderTree, bookmarksInFolder } from '../src/server/tools-read.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);

describe('folderTree', () => {
  it('nests Rust under Dev', () => {
    const tree = folderTree(index);
    const bar = tree.find(f => f.title === 'Bookmarks bar')!;
    const dev = bar.children.find(f => f.title === 'Dev')!;
    expect(dev.children.map(c => c.title)).toContain('Rust');
  });

  it('carries counts through', () => {
    const bar = folderTree(index).find(f => f.title === 'Bookmarks bar')!;
    const dev = bar.children.find(f => f.title === 'Dev')!;
    expect(dev.totalCount).toBe(3);
  });

  it('returns every root at the top level', () => {
    expect(folderTree(index).map(f => f.title).sort()).toEqual([
      'Bookmarks bar',
      'Mobile bookmarks',
      'Other bookmarks'
    ]);
  });
});

describe('bookmarksInFolder', () => {
  it('returns only direct children of the folder', () => {
    const rows = bookmarksInFolder(index, '/Bookmarks bar/Dev', 0, 50);
    expect(rows.every(b => b.folderPath === '/Bookmarks bar/Dev')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('paginates', () => {
    expect(bookmarksInFolder(index, '/Bookmarks bar/Dev', 1, 1)).toHaveLength(1);
  });

  it('does not leak nested folder contents into the parent', () => {
    const rows = bookmarksInFolder(index, '/Bookmarks bar/Dev', 0, 50);
    expect(rows.some(b => b.title === 'The Book')).toBe(false);
  });

  it('returns an empty list for an unknown folder', () => {
    expect(bookmarksInFolder(index, '/nope', 0, 50)).toEqual([]);
  });
});
