import { describe, it, expect } from 'vitest';
import { flattenTree, hostname, initial, markColor } from '../views/src/explorer.js';
import type { TreeNode } from '../views/src/explorer.js';

const tree: TreeNode[] = [
  {
    id: '1',
    title: 'Bookmarks bar',
    folderPath: '/Bookmarks bar',
    bookmarkCount: 2,
    totalCount: 5,
    children: [
      {
        id: '2',
        title: 'Dev',
        folderPath: '/Bookmarks bar/Dev',
        bookmarkCount: 2,
        totalCount: 3,
        children: [
          {
            id: '3',
            title: 'Rust',
            folderPath: '/Bookmarks bar/Dev/Rust',
            bookmarkCount: 1,
            totalCount: 1,
            children: []
          }
        ]
      }
    ]
  }
];

describe('flattenTree', () => {
  it('hides children of collapsed folders', () => {
    expect(flattenTree(tree, new Set()).map(r => r.title)).toEqual(['Bookmarks bar']);
  });

  it('reveals one level per expanded folder', () => {
    expect(flattenTree(tree, new Set(['1'])).map(r => r.title)).toEqual(['Bookmarks bar', 'Dev']);
  });

  it('tracks depth for indentation', () => {
    const rows = flattenTree(tree, new Set(['1', '2']));
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2]);
  });

  it('marks which rows can expand', () => {
    const rows = flattenTree(tree, new Set(['1', '2']));
    expect(rows.map(r => r.hasChildren)).toEqual([true, true, false]);
  });
});

describe('hostname', () => {
  it('strips the scheme and www', () => {
    expect(hostname('https://www.rust-lang.org/learn')).toBe('rust-lang.org');
  });

  it('returns the raw string for an unparseable url', () => {
    expect(hostname('not a url')).toBe('not a url');
  });
});

describe('initial', () => {
  it('uses the first letter of the title', () => {
    expect(initial('Rust', 'https://rust-lang.org')).toBe('R');
  });

  it('falls back to the hostname when the title is blank', () => {
    expect(initial('   ', 'https://zig.org')).toBe('Z');
  });
});

describe('markColor', () => {
  it('is stable for the same seed', () => {
    expect(markColor('rust-lang.org')).toBe(markColor('rust-lang.org'));
  });

  it('differs across hosts', () => {
    expect(markColor('rust-lang.org')).not.toBe(markColor('python.org'));
  });
});
