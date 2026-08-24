import { describe, it, expect } from 'vitest';
import { fuseRRF } from '../src/server/search/hybrid.js';
import { cosine } from '../src/server/search/semantic.js';
import type { BookmarkNode } from '../src/server/types.js';
import type { ScoredHit } from '../src/server/search/types.js';

const mk = (title: string): BookmarkNode => ({
  id: title,
  guid: title,
  title,
  url: 'https://x.com',
  parentId: '1',
  index: 0,
  folderPath: '/',
  dateAdded: 0
});
const hit = (title: string, score: number): ScoredHit => ({ bookmark: mk(title), score });

describe('cosine', () => {
  it('is 1 for identical vectors', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is 0 when either vector is all zeroes', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('fuseRRF', () => {
  it('promotes an item that appears in both lists over one that tops only a single list', () => {
    const fuzzy = [hit('a', 100), hit('b', 90)];
    const semantic = [hit('c', 1), hit('b', 0.9)];
    const fused = fuseRRF([fuzzy, semantic], [1, 1]);
    expect(fused[0].bookmark.title).toBe('b');
  });

  it('dedupes by bookmark id', () => {
    const fused = fuseRRF([[hit('a', 1)], [hit('a', 1)]], [1, 1]);
    expect(fused).toHaveLength(1);
  });

  it('respects list weights', () => {
    const fuzzy = [hit('a', 1)];
    const semantic = [hit('b', 1)];
    expect(fuseRRF([fuzzy, semantic], [10, 1])[0].bookmark.title).toBe('a');
    expect(fuseRRF([fuzzy, semantic], [1, 10])[0].bookmark.title).toBe('b');
  });

  it('returns an empty list when every input list is empty', () => {
    expect(fuseRRF([[], []], [1, 1])).toEqual([]);
  });
});
