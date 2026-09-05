import * as z from 'zod';
import type { BookmarkIndex } from './types.js';

/**
 * A parent reference is either a real Chrome folder id or `temp:<tempId>`
 * pointing at a create_folder op earlier in the same plan.
 */
export const TEMP_PREFIX = 'temp:';

export const OpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_folder'),
    tempId: z.string().min(1),
    parentId: z.string().min(1),
    title: z.string().min(1)
  }),
  z.object({
    op: z.literal('create_bookmark'),
    tempId: z.string().min(1),
    parentId: z.string().min(1),
    title: z.string(),
    url: z.string().min(1),
    index: z.number().int().min(0).optional()
  }),
  z.object({
    op: z.literal('move'),
    id: z.string().min(1),
    parentId: z.string().min(1),
    index: z.number().int().min(0).optional()
  }),
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    title: z.string().optional(),
    url: z.string().optional()
  }),
  z.object({
    op: z.literal('delete'),
    id: z.string().min(1),
    hard: z.boolean().optional()
  })
]);

export const PlanSchema = z.object({
  id: z.string().min(1),
  ops: z.array(OpSchema),
  note: z.string().optional()
});

export type Op = z.infer<typeof OpSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface PlanRow {
  kind: 'move' | 'update' | 'delete' | 'create_folder' | 'create_bookmark';
  id: string;
  title: string;
  url?: string;
  from?: string;
  to?: string;
  detail?: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isTemp(parentId: string): boolean {
  return parentId.startsWith(TEMP_PREFIX);
}

function tempKey(parentId: string): string {
  return parentId.slice(TEMP_PREFIX.length);
}

export function validatePlan(plan: Plan, index: BookmarkIndex): ValidationResult {
  const errors: string[] = [];
  const created = new Set<string>();

  const checkParent = (parentId: string, at: number) => {
    if (isTemp(parentId)) {
      if (!created.has(tempKey(parentId))) {
        errors.push(
          `op ${at}: parent ${parentId} refers to a folder that is not created earlier in this plan`
        );
      }
      return;
    }
    if (!index.folderById.has(parentId)) {
      errors.push(`op ${at}: parent folder ${parentId} does not exist`);
    }
  };

  const checkBookmark = (id: string, at: number) => {
    if (!index.byId.has(id)) errors.push(`op ${at}: bookmark ${id} does not exist`);
  };

  // Moves may target a folder as well as a bookmark; Chrome moves either.
  const checkMovable = (id: string, at: number) => {
    if (!index.byId.has(id) && !index.folderById.has(id)) {
      errors.push(`op ${at}: bookmark or folder ${id} does not exist`);
    }
  };

  plan.ops.forEach((op, at) => {
    switch (op.op) {
      case 'create_folder':
      case 'create_bookmark':
        if (created.has(op.tempId)) errors.push(`op ${at}: duplicate tempId ${op.tempId}`);
        checkParent(op.parentId, at);
        created.add(op.tempId);
        break;
      case 'move':
        checkMovable(op.id, at);
        checkParent(op.parentId, at);
        break;
      case 'update':
        checkBookmark(op.id, at);
        if (op.title === undefined && op.url === undefined) {
          errors.push(`op ${at}: update sets neither title nor url`);
        }
        break;
      case 'delete':
        checkBookmark(op.id, at);
        break;
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Inverse ops computed from the pre-apply state, returned in reverse order so
 * replaying them unwinds the batch.
 *
 * create_folder and create_bookmark invert to a delete of a node whose real id
 * is only known after the batch runs, so they carry the tempId and are resolved
 * against the bridge's applied-op report at undo time.
 */
export function inverseOps(plan: Plan, index: BookmarkIndex): Op[] {
  const inverse: Op[] = [];

  for (const op of plan.ops) {
    switch (op.op) {
      case 'move': {
        const before = index.byId.get(op.id) ?? index.folderById.get(op.id);
        if (!before || before.parentId === null) break;
        inverse.push({ op: 'move', id: op.id, parentId: before.parentId, index: before.index });
        break;
      }
      case 'update': {
        const before = index.byId.get(op.id);
        if (!before) break;
        const restore: Op = { op: 'update', id: op.id };
        if (op.title !== undefined) restore.title = before.title;
        if (op.url !== undefined) restore.url = before.url;
        inverse.push(restore);
        break;
      }
      case 'delete': {
        const before = index.byId.get(op.id);
        if (!before) break;
        inverse.push({
          op: 'create_bookmark',
          tempId: `undo-${op.id}`,
          parentId: before.parentId,
          title: before.title,
          url: before.url,
          index: before.index
        });
        break;
      }
      case 'create_folder':
      case 'create_bookmark':
        inverse.push({ op: 'delete', id: `${TEMP_PREFIX}${op.tempId}`, hard: true });
        break;
    }
  }

  return inverse.reverse();
}

/** Resolves a parent reference to a readable folder path for the review UI. */
function resolvePath(
  parentId: string,
  index: BookmarkIndex,
  pendingFolders: Map<string, string>
): string {
  if (isTemp(parentId)) return pendingFolders.get(tempKey(parentId)) ?? parentId;
  return index.folderById.get(parentId)?.folderPath ?? parentId;
}

export function planToRows(plan: Plan, index: BookmarkIndex): PlanRow[] {
  const rows: PlanRow[] = [];
  const pendingFolders = new Map<string, string>();

  for (const op of plan.ops) {
    switch (op.op) {
      case 'create_folder': {
        const parentPath = resolvePath(op.parentId, index, pendingFolders);
        const path = `${parentPath}/${op.title}`;
        pendingFolders.set(op.tempId, path);
        rows.push({ kind: 'create_folder', id: `${TEMP_PREFIX}${op.tempId}`, title: op.title, to: path });
        break;
      }
      case 'create_bookmark': {
        const path = resolvePath(op.parentId, index, pendingFolders);
        rows.push({
          kind: 'create_bookmark',
          id: `${TEMP_PREFIX}${op.tempId}`,
          title: op.title,
          url: op.url,
          to: path
        });
        break;
      }
      case 'move': {
        const before = index.byId.get(op.id);
        const folder = before ? undefined : index.folderById.get(op.id);
        const row: PlanRow = {
          kind: 'move',
          id: op.id,
          title: before?.title ?? folder?.title ?? op.id,
          to: resolvePath(op.parentId, index, pendingFolders)
        };
        if (before) {
          row.url = before.url;
          row.from = before.folderPath;
        } else if (folder && folder.parentId !== null) {
          row.from = index.folderById.get(folder.parentId)?.folderPath ?? folder.parentId;
        }
        rows.push(row);
        break;
      }
      case 'update': {
        const before = index.byId.get(op.id);
        const changes: string[] = [];
        if (op.title !== undefined) changes.push(`title to "${op.title}"`);
        if (op.url !== undefined) changes.push(`url to ${op.url}`);
        rows.push({
          kind: 'update',
          id: op.id,
          title: before?.title ?? op.id,
          detail: changes.join(', ')
        });
        break;
      }
      case 'delete': {
        const before = index.byId.get(op.id);
        const row: PlanRow = {
          kind: 'delete',
          id: op.id,
          title: before?.title ?? op.id,
          detail: op.hard ? 'permanent delete' : 'move to _MCP Trash'
        };
        if (before) {
          row.url = before.url;
          row.from = before.folderPath;
        }
        rows.push(row);
        break;
      }
    }
  }

  return rows;
}
