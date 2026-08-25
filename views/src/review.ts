import { connectHost, type HostConnection } from './host.js';

export interface PlanRow {
  kind: 'move' | 'update' | 'delete' | 'create_folder' | 'create_bookmark';
  id: string;
  title: string;
  url?: string;
  from?: string;
  to?: string;
  detail?: string;
}

export interface Op {
  op: string;
  id?: string;
  tempId?: string;
  parentId?: string;
  title?: string;
  url?: string;
  index?: number;
  hard?: boolean;
}

export interface Plan {
  id: string;
  ops: Op[];
  note?: string;
}

export interface RowGroup {
  label: string;
  kind: PlanRow['kind'];
  rows: PlanRow[];
}

const TEMP_PREFIX = 'temp:';

/** Moves group by destination so a reorg reads as "these go here". */
export function groupRows(rows: PlanRow[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();

  const put = (key: string, label: string, kind: PlanRow['kind'], row: PlanRow) => {
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { label, kind, rows: [row] });
  };

  for (const row of rows) {
    if (row.kind === 'move') put(`move:${row.to}`, row.to ?? 'Unknown folder', 'move', row);
    else if (row.kind === 'delete') put('delete', 'Delete', 'delete', row);
    else if (row.kind === 'update') put('update', 'Rename and edit', 'update', row);
    else if (row.kind === 'create_folder') put('create_folder', 'New folders', 'create_folder', row);
    else put('create_bookmark', 'New bookmarks', 'create_bookmark', row);
  }

  const order: PlanRow['kind'][] = ['create_folder', 'move', 'update', 'delete', 'create_bookmark'];
  return [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

function opRowId(op: Op): string {
  if (op.op === 'create_folder' || op.op === 'create_bookmark') return `${TEMP_PREFIX}${op.tempId}`;
  return op.id ?? '';
}

/**
 * Drops rejected ops, then drops any folder creation nothing still needs. A
 * create_folder whose every consumer was rejected would otherwise leave an
 * empty folder behind.
 */
export function filterPlan(plan: Plan, rejectedIds: Set<string>): Plan {
  const kept = plan.ops.filter(op => !rejectedIds.has(opRowId(op)));

  let changed = true;
  let result = kept;
  while (changed) {
    changed = false;
    const referenced = new Set<string>();
    for (const op of result) {
      if (op.parentId?.startsWith(TEMP_PREFIX)) referenced.add(op.parentId.slice(TEMP_PREFIX.length));
    }
    const next = result.filter(op => {
      if (op.op !== 'create_folder') return true;
      return referenced.has(op.tempId ?? '');
    });
    if (next.length !== result.length) {
      result = next;
      changed = true;
    }
  }

  const filtered: Plan = { id: plan.id, ops: result };
  if (plan.note !== undefined) filtered.note = plan.note;
  return filtered;
}

export function countsOf(plan: Plan): string {
  const counts = new Map<string, number>();
  for (const op of plan.ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
  const label: Record<string, string> = {
    move: 'move',
    delete: 'delete',
    update: 'edit',
    create_folder: 'new folder',
    create_bookmark: 'new bookmark'
  };
  const parts = [...counts.entries()].map(([op, n]) => `${n} ${label[op] ?? op}${n === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'no changes';
}

interface State {
  plan: Plan | null;
  rows: PlanRow[];
  errors: string[];
  rejected: Set<string>;
  status: 'review' | 'applying' | 'done' | 'failed';
  message: string;
}

const state: State = {
  plan: null,
  rows: [],
  errors: [],
  rejected: new Set(),
  status: 'review',
  message: ''
};

let host: HostConnection | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function keptPlan(): Plan {
  return state.plan ? filterPlan(state.plan, state.rejected) : { id: 'empty', ops: [] };
}

function renderRow(row: PlanRow): HTMLElement {
  const line = el('label', 'row');
  if (state.rejected.has(row.id)) line.classList.add('rejected');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !state.rejected.has(row.id);
  box.addEventListener('change', () => {
    if (box.checked) state.rejected.delete(row.id);
    else state.rejected.add(row.id);
    render();
  });

  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', row.title));

  if (row.kind === 'move' && row.from) {
    const path = el('span', 'row-path');
    path.append(el('span', 'chip from', row.from), el('span', 'arrow', '→'), el('span', 'chip to', row.to ?? ''));
    body.append(path);
  } else if (row.detail) {
    body.append(el('span', 'row-detail', row.detail));
  } else if (row.to) {
    body.append(el('span', 'row-detail', row.to));
  }

  line.append(box, body);
  return line;
}

function renderGroups(container: HTMLElement): void {
  container.replaceChildren();
  const groups = groupRows(state.rows);

  if (!groups.length) {
    container.append(el('p', 'empty', 'This plan contains no changes.'));
    return;
  }

  for (const group of groups) {
    const section = el('section', `group ${group.kind}`);
    const header = el('div', 'group-head');

    const allRejected = group.rows.every(r => state.rejected.has(r.id));
    const toggle = el('button', 'group-toggle', allRejected ? 'Include all' : 'Exclude all');
    toggle.addEventListener('click', () => {
      for (const row of group.rows) {
        if (allRejected) state.rejected.delete(row.id);
        else state.rejected.add(row.id);
      }
      render();
    });

    const kept = group.rows.filter(r => !state.rejected.has(r.id)).length;
    header.append(
      el('span', 'group-label', group.label),
      el('span', 'group-count', `${kept} of ${group.rows.length}`),
      toggle
    );

    section.append(header);
    for (const row of group.rows) section.append(renderRow(row));
    container.append(section);
  }
}

function render(): void {
  const errorBox = document.getElementById('errors')!;
  errorBox.replaceChildren();
  if (state.errors.length) {
    errorBox.append(el('strong', undefined, `This plan has ${state.errors.length} problems:`));
    const list = el('ul');
    for (const message of state.errors) list.append(el('li', undefined, message));
    errorBox.append(list);
    errorBox.classList.remove('hidden');
  } else {
    errorBox.classList.add('hidden');
  }

  document.getElementById('note')!.textContent = state.plan?.note ?? '';
  document.getElementById('counts')!.textContent = countsOf(keptPlan());

  renderGroups(document.getElementById('groups')!);

  const apply = document.getElementById('apply') as HTMLButtonElement;
  const kept = keptPlan().ops.length;
  apply.disabled = state.status === 'applying' || state.status === 'done' || !kept || state.errors.length > 0;
  apply.textContent =
    state.status === 'applying'
      ? 'Applying.'
      : state.status === 'done'
        ? 'Applied'
        : `Apply ${kept} ${kept === 1 ? 'change' : 'changes'}`;

  const status = document.getElementById('status')!;
  status.textContent = state.message;
  status.className = `status ${state.status}`;
}

async function apply(): Promise<void> {
  if (!host || !state.plan) return;
  state.status = 'applying';
  state.message = 'Sending the batch to Chrome.';
  render();

  const result = await host.callTool<{ applied: boolean; backup?: string; error?: string }>('apply_plan', {
    plan: keptPlan() as unknown as Record<string, unknown>
  });

  if (result?.applied) {
    state.status = 'done';
    state.message = `Applied. Backup at ${result.backup ?? 'the state directory'}. Ask Claude to undo the last batch if this was wrong.`;
  } else {
    state.status = 'failed';
    state.message = result?.error ?? 'The batch did not apply. Nothing was changed.';
  }
  render();
}

function applyToolResult(structured: Record<string, unknown> | undefined): void {
  if (!structured) return;

  if (structured.plan) state.plan = structured.plan as Plan;
  if (Array.isArray(structured.rows)) state.rows = structured.rows as PlanRow[];
  if (Array.isArray(structured.errors)) state.errors = structured.errors as string[];

  if (structured.applied === true) {
    state.status = 'done';
    state.message = `Applied. Backup at ${String(structured.backup ?? 'the state directory')}.`;
  }

  render();
}

function layout(): void {
  const root = document.getElementById('root')!;
  root.innerHTML = `
    <div class="wrap">
      <header class="head">
        <h1>Review reorganization</h1>
        <p id="note"></p>
        <p id="counts" class="counts"></p>
      </header>
      <div id="errors" class="errors hidden"></div>
      <div id="groups" class="groups"></div>
      <footer class="foot">
        <span id="status" class="status"></span>
        <button id="apply" class="apply">Apply</button>
      </footer>
    </div>
  `;
  document.getElementById('apply')!.addEventListener('click', () => void apply());
}

async function main(): Promise<void> {
  layout();
  render();
  host = await connectHost({ name: 'bookmark-reorg-review', version: '0.1.0' }, applyToolResult);
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  void main();
}
