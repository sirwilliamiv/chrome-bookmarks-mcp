import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { normalizeUrl, findDuplicates, duplicatePlan, deadLinkPlan } from '../src/server/generators.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);

describe('normalizeUrl', () => {
  it('ignores a trailing slash', () => {
    expect(normalizeUrl('https://x.com/a/')).toBe(normalizeUrl('https://x.com/a'));
  });

  it('ignores the scheme and a www prefix', () => {
    expect(normalizeUrl('http://www.x.com/a')).toBe(normalizeUrl('https://x.com/a'));
  });

  it('ignores utm parameters but keeps meaningful ones', () => {
    expect(normalizeUrl('https://x.com/a?utm_source=t')).toBe(normalizeUrl('https://x.com/a'));
    expect(normalizeUrl('https://x.com/a?id=1')).not.toBe(normalizeUrl('https://x.com/a'));
  });

  it('ignores the fragment', () => {
    expect(normalizeUrl('https://x.com/a#top')).toBe(normalizeUrl('https://x.com/a'));
  });

  it('is order insensitive across query parameters', () => {
    expect(normalizeUrl('https://x.com/a?b=2&a=1')).toBe(normalizeUrl('https://x.com/a?a=1&b=2'));
  });

  it('returns the raw string when the url cannot be parsed', () => {
    expect(normalizeUrl('javascript:void(0)')).toBe('javascript:void(0)');
  });
});

describe('findDuplicates', () => {
  it('clusters the fixture duplicate pair', () => {
    const clusters = findDuplicates(index);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it('never returns a cluster of one', () => {
    expect(findDuplicates(index).every(c => c.length >= 2)).toBe(true);
  });
});

describe('duplicatePlan', () => {
  it('deletes all but the oldest of each cluster', () => {
    const plan = duplicatePlan(index);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].op).toBe('delete');

    const cluster = findDuplicates(index)[0];
    const oldest = [...cluster].sort((a, b) => a.dateAdded - b.dateAdded)[0];
    expect((plan.ops[0] as { id: string }).id).not.toBe(oldest.id);
  });

  it('explains itself in the note', () => {
    expect(duplicatePlan(index).note).toMatch(/duplicate/i);
  });
});

describe('deadLinkPlan', () => {
  it('deletes only the urls the checker reports dead', async () => {
    const dead = new Set(['https://dead.example.com/']);
    const plan = await deadLinkPlan(index, async url => !dead.has(url));
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]).toMatchObject({ op: 'delete', id: '16' });
  });

  it('produces an empty plan when everything is alive', async () => {
    const plan = await deadLinkPlan(index, async () => true);
    expect(plan.ops).toEqual([]);
  });

  it('never checks the same url twice', async () => {
    const seen: string[] = [];
    await deadLinkPlan(index, async url => {
      seen.push(url);
      return true;
    });
    expect(new Set(seen).size).toBe(seen.length);
  });
});
