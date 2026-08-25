import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { resolveSoftDeletes, TRASH_FOLDER } from '../src/server/tools-write.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);

describe('resolveSoftDeletes', () => {
  it('rewrites a soft delete into a move to the trash folder', () => {
    const id = index.bookmarks[0].id;
    const out = resolveSoftDeletes({ id: 'p1', ops: [{ op: 'delete', id }] }, index);
    expect(out.ops.some(op => op.op === 'create_folder' && op.title === TRASH_FOLDER)).toBe(true);
    expect(out.ops.some(op => op.op === 'move' && op.id === id)).toBe(true);
    expect(out.ops.some(op => op.op === 'delete')).toBe(false);
  });

  it('leaves a hard delete alone', () => {
    const id = index.bookmarks[0].id;
    const out = resolveSoftDeletes({ id: 'p1', ops: [{ op: 'delete', id, hard: true }] }, index);
    expect(out.ops).toEqual([{ op: 'delete', id, hard: true }]);
  });

  it('does not create the trash folder twice', () => {
    const ids = index.bookmarks.slice(0, 2).map(b => b.id);
    const out = resolveSoftDeletes({ id: 'p1', ops: ids.map(id => ({ op: 'delete' as const, id })) }, index);
    expect(out.ops.filter(op => op.op === 'create_folder')).toHaveLength(1);
  });

  it('leaves a plan with no deletes untouched', () => {
    const plan = { id: 'p1', ops: [{ op: 'move' as const, id: index.bookmarks[0].id, parentId: '2' }] };
    expect(resolveSoftDeletes(plan, index)).toEqual(plan);
  });

  it('reuses an existing trash folder rather than creating another', () => {
    const withTrash = structuredClone({
      ...index,
      folders: [...index.folders],
      folderById: index.folderById
    });
    withTrash.folders.push({
      id: '900',
      guid: 'trash-guid',
      title: TRASH_FOLDER,
      parentId: '4',
      folderPath: `/Other bookmarks/${TRASH_FOLDER}`,
      bookmarkCount: 0,
      totalCount: 0
    });
    withTrash.folderById = new Map(withTrash.folders.map(f => [f.id, f]));
    withTrash.byId = index.byId;

    const out = resolveSoftDeletes({ id: 'p1', ops: [{ op: 'delete', id: index.bookmarks[0].id }] }, withTrash);
    expect(out.ops.some(op => op.op === 'create_folder')).toBe(false);
    expect(out.ops[0]).toMatchObject({ op: 'move', parentId: '900' });
  });
});
