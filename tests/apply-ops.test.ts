import { describe, it, expect } from 'vitest';
// @ts-expect-error plain js module shared with the extension
import { applyOps } from '../extension/apply-ops.js';

function mockBookmarks() {
  const nodes = new Map<string, any>([
    ['1', { id: '1', title: 'bar', children: [] }],
    ['10', { id: '10', title: 'Rust', url: 'https://rust-lang.org', parentId: '1', index: 0 }]
  ]);
  let nextId = 100;
  return {
    nodes,
    async create({ parentId, title, url, index }: any) {
      const id = String(nextId++);
      const node = { id, parentId, title, url, index: index ?? 0 };
      nodes.set(id, node);
      return node;
    },
    async move(id: string, dest: any) {
      const node = nodes.get(id);
      if (!node) throw new Error('no such node');
      Object.assign(node, dest);
      return node;
    },
    async update(id: string, changes: any) {
      const node = nodes.get(id);
      if (!node) throw new Error('no such node');
      Object.assign(node, changes);
      return node;
    },
    async remove(id: string) {
      if (!nodes.delete(id)) throw new Error('no such node');
    }
  };
}

describe('applyOps', () => {
  it('creates a folder and reports its real id against the temp id', async () => {
    const api = mockBookmarks();
    const applied = await applyOps([{ op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' }], api);
    expect(applied[0].tempId).toBe('t1');
    expect(api.nodes.has(applied[0].newId!)).toBe(true);
  });

  it('creates a folder with no url so chrome treats it as a folder', async () => {
    const api = mockBookmarks();
    const applied = await applyOps([{ op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' }], api);
    expect(api.nodes.get(applied[0].newId!).url).toBeUndefined();
  });

  it('resolves a temp parent reference from an earlier op in the batch', async () => {
    const api = mockBookmarks();
    const applied = await applyOps(
      [
        { op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'move', id: '10', parentId: 'temp:t1' }
      ],
      api
    );
    expect(api.nodes.get('10').parentId).toBe(applied[0].newId);
  });

  it('resolves a temp id used as a delete target', async () => {
    const api = mockBookmarks();
    await applyOps(
      [
        { op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'delete', id: 'temp:t1', hard: true }
      ],
      api
    );
    expect([...api.nodes.values()].some(n => n.title === 'Dev')).toBe(false);
  });

  it('applies an update', async () => {
    const api = mockBookmarks();
    await applyOps([{ op: 'update', id: '10', title: 'The Rust Book' }], api);
    expect(api.nodes.get('10').title).toBe('The Rust Book');
  });

  it('creates a bookmark carrying its url', async () => {
    const api = mockBookmarks();
    const applied = await applyOps(
      [{ op: 'create_bookmark', tempId: 'b1', parentId: '1', title: 'Zig', url: 'https://ziglang.org' }],
      api
    );
    expect(api.nodes.get(applied[0].newId!).url).toBe('https://ziglang.org');
  });

  it('removes on a hard delete', async () => {
    const api = mockBookmarks();
    await applyOps([{ op: 'delete', id: '10', hard: true }], api);
    expect(api.nodes.has('10')).toBe(false);
  });

  it('throws with the failing op index', async () => {
    const api = mockBookmarks();
    await expect(
      applyOps([{ op: 'update', id: '10', title: 'ok' }, { op: 'delete', id: 'missing', hard: true }], api)
    ).rejects.toMatchObject({ index: 1 });
  });

  it('reports how many ops succeeded before the failure', async () => {
    const api = mockBookmarks();
    await expect(
      applyOps([{ op: 'update', id: '10', title: 'ok' }, { op: 'delete', id: 'missing', hard: true }], api)
    ).rejects.toMatchObject({ appliedCount: 1 });
  });

  it('returns an empty list for an empty batch', async () => {
    expect(await applyOps([], mockBookmarks())).toEqual([]);
  });
});
