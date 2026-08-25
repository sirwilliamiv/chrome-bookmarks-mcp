import { describe, it, expect } from 'vitest';
import { groupRows, filterPlan, countsOf } from '../views/src/review.js';
import type { PlanRow, Plan } from '../views/src/review.js';

const rows: PlanRow[] = [
  { kind: 'move', id: 'a', title: 'A', from: '/bar', to: '/bar/Dev' },
  { kind: 'move', id: 'b', title: 'B', from: '/bar', to: '/bar/Dev' },
  { kind: 'delete', id: 'c', title: 'C', detail: 'duplicate' }
];

describe('groupRows', () => {
  it('groups moves by destination folder', () => {
    const dev = groupRows(rows).find(g => g.label === '/bar/Dev')!;
    expect(dev.rows).toHaveLength(2);
  });

  it('puts deletes in their own group', () => {
    expect(groupRows(rows).some(g => g.label === 'Delete')).toBe(true);
  });

  it('splits moves with different destinations', () => {
    const withOther: PlanRow[] = [...rows, { kind: 'move', id: 'd', title: 'D', from: '/bar', to: '/bar/Ops' }];
    expect(groupRows(withOther).filter(g => g.kind === 'move')).toHaveLength(2);
  });

  it('orders new folders before the moves that need them', () => {
    const withFolder: PlanRow[] = [
      { kind: 'move', id: 'a', title: 'A', from: '/bar', to: '/bar/Dev' },
      { kind: 'create_folder', id: 'temp:t1', title: 'Dev', to: '/bar/Dev' }
    ];
    expect(groupRows(withFolder)[0].kind).toBe('create_folder');
  });
});

describe('filterPlan', () => {
  it('drops ops whose row was rejected', () => {
    const plan: Plan = { id: 'p', ops: [{ op: 'move', id: 'a', parentId: '2' }, { op: 'delete', id: 'c' }] };
    expect(filterPlan(plan, new Set(['c'])).ops).toHaveLength(1);
  });

  it('keeps a create_folder op when any move still targets it', () => {
    const plan: Plan = {
      id: 'p',
      ops: [
        { op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'move', id: 'a', parentId: 'temp:t1' },
        { op: 'move', id: 'b', parentId: 'temp:t1' }
      ]
    };
    expect(filterPlan(plan, new Set(['b'])).ops).toHaveLength(2);
  });

  it('drops a create_folder op when every move targeting it was rejected', () => {
    const plan: Plan = {
      id: 'p',
      ops: [
        { op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'move', id: 'a', parentId: 'temp:t1' }
      ]
    };
    expect(filterPlan(plan, new Set(['a'])).ops).toHaveLength(0);
  });

  it('drops a chain of now-empty nested folders', () => {
    const plan: Plan = {
      id: 'p',
      ops: [
        { op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'create_folder', tempId: 't2', parentId: 'temp:t1', title: 'Rust' },
        { op: 'move', id: 'a', parentId: 'temp:t2' }
      ]
    };
    expect(filterPlan(plan, new Set(['a'])).ops).toHaveLength(0);
  });

  it('lets the user reject a folder creation directly', () => {
    const plan: Plan = {
      id: 'p',
      ops: [{ op: 'create_folder', tempId: 't1', parentId: '1', title: 'Dev' }]
    };
    expect(filterPlan(plan, new Set(['temp:t1'])).ops).toHaveLength(0);
  });

  it('preserves the note', () => {
    const plan: Plan = { id: 'p', ops: [], note: 'tidy up' };
    expect(filterPlan(plan, new Set()).note).toBe('tidy up');
  });
});

describe('countsOf', () => {
  it('pluralises correctly', () => {
    expect(countsOf({ id: 'p', ops: [{ op: 'move', id: 'a', parentId: '1' }] })).toBe('1 move');
    expect(
      countsOf({
        id: 'p',
        ops: [
          { op: 'move', id: 'a', parentId: '1' },
          { op: 'move', id: 'b', parentId: '1' }
        ]
      })
    ).toBe('2 moves');
  });

  it('reports an empty plan plainly', () => {
    expect(countsOf({ id: 'p', ops: [] })).toBe('no changes');
  });
});
