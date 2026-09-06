import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { validatePlan, inverseOps, planToRows } from '../src/server/plan.js';
import type { Plan } from '../src/server/plan.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);
const anyBookmark = index.bookmarks[0];
const devFolder = index.folders.find(f => f.title === 'Dev')!;

describe('validatePlan', () => {
  it('accepts a move to an existing folder', () => {
    const result = validatePlan(
      { id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: devFolder.id }] },
      index
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a move of an unknown bookmark and names the id', () => {
    const result = validatePlan({ id: 'p1', ops: [{ op: 'move', id: 'nope', parentId: devFolder.id }] }, index);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('nope');
  });

  it('accepts a move of a folder and inverts it to its original parent and index', () => {
    const parentFolder = index.folderById.get(devFolder.parentId!)!;
    const result = validatePlan(
      { id: 'p1', ops: [{ op: 'move', id: devFolder.id, parentId: parentFolder.id, index: 0 }] },
      index
    );
    expect(result.ok).toBe(true);
    const inverse = inverseOps(
      { id: 'p1', ops: [{ op: 'move', id: devFolder.id, parentId: parentFolder.id, index: 0 }] },
      index
    );
    expect(inverse).toEqual([
      { op: 'move', id: devFolder.id, parentId: devFolder.parentId, index: devFolder.index }
    ]);
    const rows = planToRows(
      { id: 'p1', ops: [{ op: 'move', id: devFolder.id, parentId: parentFolder.id, index: 0 }] },
      index
    );
    expect(rows[0]).toMatchObject({ kind: 'move', title: 'Dev', from: parentFolder.folderPath });
  });

  it('accepts a folder rename and inverts it, but rejects a folder url change', () => {
    const rename: Plan = { id: 'p1', ops: [{ op: 'update', id: devFolder.id, title: 'Development' }] };
    expect(validatePlan(rename, index).ok).toBe(true);
    expect(inverseOps(rename, index)).toEqual([{ op: 'update', id: devFolder.id, title: 'Dev' }]);
    expect(planToRows(rename, index)[0]).toMatchObject({ kind: 'update', title: 'Dev' });

    const badUrl = validatePlan({ id: 'p1', ops: [{ op: 'update', id: devFolder.id, url: 'https://x' }] }, index);
    expect(badUrl.ok).toBe(false);
  });

  it('accepts a soft delete of a folder but not a hard one', () => {
    expect(validatePlan({ id: 'p1', ops: [{ op: 'delete', id: devFolder.id }] }, index).ok).toBe(true);
    expect(planToRows({ id: 'p1', ops: [{ op: 'delete', id: devFolder.id }] }, index)[0]).toMatchObject({
      kind: 'delete',
      title: 'Dev'
    });
    const hard = validatePlan({ id: 'p1', ops: [{ op: 'delete', id: devFolder.id, hard: true }] }, index);
    expect(hard.ok).toBe(false);
    if (!hard.ok) expect(hard.errors.join(' ')).toContain('hard delete');
  });

  it('never lets a root folder move or be deleted', () => {
    const root = index.folders.find(f => f.parentId === null)!;
    const result = validatePlan({ id: 'p1', ops: [{ op: 'delete', id: root.id }] }, index);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('root folder');
  });

  it('rejects a move into an unknown folder', () => {
    const result = validatePlan({ id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: '9999' }] }, index);
    expect(result.ok).toBe(false);
  });

  it('accepts a move into a folder created earlier in the same plan', () => {
    const result = validatePlan(
      {
        id: 'p1',
        ops: [
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'Rust' },
          { op: 'move', id: anyBookmark.id, parentId: 'temp:t1' }
        ]
      },
      index
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a forward reference to a folder created later', () => {
    const result = validatePlan(
      {
        id: 'p1',
        ops: [
          { op: 'move', id: anyBookmark.id, parentId: 'temp:t1' },
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'Rust' }
        ]
      },
      index
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate tempId', () => {
    const result = validatePlan(
      {
        id: 'p1',
        ops: [
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'A' },
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'B' }
        ]
      },
      index
    );
    expect(result.ok).toBe(false);
  });

  it('collects every error rather than stopping at the first', () => {
    const result = validatePlan(
      {
        id: 'p1',
        ops: [
          { op: 'move', id: 'nope', parentId: devFolder.id },
          { op: 'delete', id: 'also-nope' }
        ]
      },
      index
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });

  it('rejects an update that changes nothing', () => {
    const result = validatePlan({ id: 'p1', ops: [{ op: 'update', id: anyBookmark.id }] }, index);
    expect(result.ok).toBe(false);
  });
});

describe('inverseOps', () => {
  it('inverts a move back to the original parent and index', () => {
    const inverse = inverseOps(
      { id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: devFolder.id }] },
      index
    );
    expect(inverse).toEqual([
      { op: 'move', id: anyBookmark.id, parentId: anyBookmark.parentId, index: anyBookmark.index }
    ]);
  });

  it('inverts an update back to the prior title', () => {
    const inverse = inverseOps({ id: 'p1', ops: [{ op: 'update', id: anyBookmark.id, title: 'New' }] }, index);
    expect(inverse[0]).toMatchObject({ op: 'update', id: anyBookmark.id, title: anyBookmark.title });
  });

  it('only restores the fields the forward op actually set', () => {
    const inverse = inverseOps({ id: 'p1', ops: [{ op: 'update', id: anyBookmark.id, title: 'New' }] }, index);
    expect(inverse[0]).not.toHaveProperty('url');
  });

  it('inverts a hard delete into a recreate carrying the url', () => {
    const inverse = inverseOps({ id: 'p1', ops: [{ op: 'delete', id: anyBookmark.id, hard: true }] }, index);
    expect(inverse[0]).toMatchObject({
      op: 'create_bookmark',
      parentId: anyBookmark.parentId,
      title: anyBookmark.title,
      url: anyBookmark.url
    });
  });

  it('returns inverse ops in reverse order of the plan', () => {
    const plan: Plan = {
      id: 'p1',
      ops: [
        { op: 'update', id: anyBookmark.id, title: 'New' },
        { op: 'move', id: anyBookmark.id, parentId: devFolder.id }
      ]
    };
    expect(inverseOps(plan, index)[0].op).toBe('move');
  });
});

describe('planToRows', () => {
  it('renders a move as a from and to pair of folder paths', () => {
    const rows = planToRows({ id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: devFolder.id }] }, index);
    expect(rows[0]).toMatchObject({
      kind: 'move',
      title: anyBookmark.title,
      from: anyBookmark.folderPath,
      to: devFolder.folderPath
    });
  });

  it('resolves a temp parent to the folder path being created', () => {
    const rows = planToRows(
      {
        id: 'p1',
        ops: [
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'Rust' },
          { op: 'move', id: anyBookmark.id, parentId: 'temp:t1' }
        ]
      },
      index
    );
    expect(rows.find(r => r.kind === 'move')?.to).toBe(`${devFolder.folderPath}/Rust`);
  });

  it('renders a delete row carrying the bookmark title', () => {
    const rows = planToRows({ id: 'p1', ops: [{ op: 'delete', id: anyBookmark.id }] }, index);
    expect(rows[0]).toMatchObject({ kind: 'delete', title: anyBookmark.title });
  });

  it('gives every row a stable id matching the op target', () => {
    const rows = planToRows({ id: 'p1', ops: [{ op: 'delete', id: anyBookmark.id }] }, index);
    expect(rows[0].id).toBe(anyBookmark.id);
  });
});
