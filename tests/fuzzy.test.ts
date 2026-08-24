import { describe, it, expect } from 'vitest';
import { scoreOne, FuzzyRanker } from '../src/server/search/fuzzy.js';
import type { BookmarkNode } from '../src/server/types.js';

const mk = (title: string, url: string, folderPath = '/Bookmarks bar'): BookmarkNode => ({
  id: title,
  guid: title,
  title,
  url,
  parentId: '1',
  index: 0,
  folderPath,
  dateAdded: 0
});

describe('scoreOne', () => {
  it('ranks an exact title match above a prefix match', () => {
    expect(scoreOne('rust', mk('rust', 'https://x.com'))).toBeGreaterThan(
      scoreOne('rust', mk('rust book', 'https://x.com'))
    );
  });

  it('ranks a title match above a url-only match', () => {
    expect(scoreOne('rust', mk('rust book', 'https://x.com'))).toBeGreaterThan(
      scoreOne('rust', mk('The Book', 'https://rust-lang.org'))
    );
  });

  it('ranks a url match above a folder-only match', () => {
    expect(scoreOne('rust', mk('The Book', 'https://rust-lang.org'))).toBeGreaterThan(
      scoreOne('rust', mk('The Book', 'https://x.com', '/Bookmarks bar/Rust'))
    );
  });

  it('is case insensitive', () => {
    expect(scoreOne('RUST', mk('Rust', 'https://x.com'))).toBe(
      scoreOne('rust', mk('Rust', 'https://x.com'))
    );
  });

  it('scores a non-match at zero', () => {
    expect(scoreOne('kubernetes', mk('Rust', 'https://rust-lang.org'))).toBe(0);
  });

  it('scores an empty query at zero', () => {
    expect(scoreOne('   ', mk('Rust', 'https://rust-lang.org'))).toBe(0);
  });
});

describe('FuzzyRanker', () => {
  it('returns only matches, best first, capped at the limit', async () => {
    const pool = [
      mk('Rust', 'https://rust-lang.org'),
      mk('Rust by Example', 'https://doc.rust-lang.org'),
      mk('Python', 'https://python.org')
    ];
    const hits = await new FuzzyRanker().rank('rust', pool, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].bookmark.title).toBe('Rust');
  });

  it('honours the limit', async () => {
    const pool = [mk('Rust', 'https://rust-lang.org'), mk('Rust by Example', 'https://doc.rust-lang.org')];
    expect(await new FuzzyRanker().rank('rust', pool, 1)).toHaveLength(1);
  });
});
