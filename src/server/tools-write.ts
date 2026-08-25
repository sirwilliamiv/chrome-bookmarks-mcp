import { readFile, unlink, writeFile } from 'node:fs/promises';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { BookmarkIndex } from './types.js';
import type { BookmarksSource } from './bookmarks-file.js';
import type { Bridge } from './bridge.js';
import { ApplyError } from './bridge.js';
import { PlanSchema, inverseOps, planToRows, validatePlan, type Op, type Plan } from './plan.js';
import { duplicatePlan, deadLinkPlan, httpLivenessCheck, withConcurrency } from './generators.js';
import { lastBatchPath, pruneBackups, snapshot } from './backup.js';
import type { AppliedOp } from '../shared/protocol.js';

export const TRASH_FOLDER = '_MCP Trash';
const TRASH_TEMP_ID = 'mcp-trash';

export interface WriteCtx {
  source: BookmarksSource;
  bridge: Bridge;
}

interface LastBatch {
  planId: string;
  inverse: Op[];
  appliedAt: string;
  backup: string;
}

/**
 * A soft delete is really a move into a trash folder, so the user can put it
 * back by hand even after the undo record is gone.
 */
export function resolveSoftDeletes(plan: Plan, index: BookmarkIndex): Plan {
  const softDeletes = plan.ops.filter(op => op.op === 'delete' && !op.hard);
  if (!softDeletes.length) return plan;

  const existingTrash = index.folders.find(f => f.title === TRASH_FOLDER);
  const otherRoot = index.folders.find(f => f.folderPath === '/Other bookmarks');
  const trashParent = existingTrash ? existingTrash.id : `temp:${TRASH_TEMP_ID}`;

  const ops: Op[] = [];
  if (!existingTrash) {
    ops.push({
      op: 'create_folder',
      tempId: TRASH_TEMP_ID,
      parentId: otherRoot?.id ?? index.folders[0].id,
      title: TRASH_FOLDER
    });
  }

  for (const op of plan.ops) {
    if (op.op === 'delete' && !op.hard) ops.push({ op: 'move', id: op.id, parentId: trashParent });
    else ops.push(op);
  }

  const next: Plan = { id: plan.id, ops };
  if (plan.note !== undefined) next.note = plan.note;
  return next;
}

async function readLastBatch(): Promise<LastBatch | null> {
  try {
    return JSON.parse(await readFile(lastBatchPath(), 'utf8')) as LastBatch;
  } catch {
    return null;
  }
}

function summarizeOps(ops: Op[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
  return [...counts.entries()].map(([op, n]) => `${n} ${op}`).join(', ') || 'nothing';
}

/**
 * The single write path. Everything else builds a Plan and calls this, so
 * validation, backup, trash rewriting, undo recording, and rollback happen in
 * exactly one place.
 */
async function applyPlanInternal(
  ctx: WriteCtx,
  plan: Plan,
  dryRun: boolean
): Promise<{ text: string; structured: Record<string, unknown>; isError?: boolean }> {
  const index = await ctx.source.get();

  const validation = validatePlan(plan, index);
  if (!validation.ok) {
    return {
      isError: true,
      text: `Plan rejected, nothing was changed:\n${validation.errors.map(e => `  ${e}`).join('\n')}`,
      structured: { applied: false, errors: validation.errors }
    };
  }

  const rows = planToRows(plan, index);
  if (dryRun) {
    return {
      text: `Dry run. ${summarizeOps(plan.ops)}. Nothing was changed.`,
      structured: { applied: false, dryRun: true, plan, rows }
    };
  }

  const backup = await snapshot(ctx.source.path);
  await pruneBackups();

  const resolved = resolveSoftDeletes(plan, index);
  const inverse = inverseOps(resolved, index);

  let applied: AppliedOp[];
  try {
    applied = await ctx.bridge.apply(resolved.ops);
  } catch (err) {
    const failure = err as ApplyError;
    let rollbackNote = '';

    if (failure instanceof ApplyError && failure.failedIndex > 0) {
      // unwind only the prefix that actually landed
      const appliedPrefix: Plan = { id: `${plan.id}-partial`, ops: resolved.ops.slice(0, failure.failedIndex) };
      try {
        await ctx.bridge.apply(inverseOps(appliedPrefix, index));
        rollbackNote = ` The ${failure.failedIndex} ops that had already applied were rolled back.`;
      } catch (rollbackErr) {
        rollbackNote =
          ` Rolling back the first ${failure.failedIndex} ops also failed: ${(rollbackErr as Error).message}. ` +
          `Restore from ${backup} if the bookmarks look wrong.`;
      }
    }

    return {
      isError: true,
      text: `${failure.message}${rollbackNote}\nA backup was taken first at ${backup}`,
      structured: { applied: false, error: failure.message, backup }
    };
  }

  // resolve create ops in the inverse record to the real ids the extension made
  const realIds = new Map(applied.filter(a => a.tempId && a.newId).map(a => [a.tempId!, a.newId!]));
  const resolvedInverse = inverse.map(op => {
    if (op.op === 'delete' && op.id.startsWith('temp:')) {
      const real = realIds.get(op.id.slice('temp:'.length));
      return real ? { ...op, id: real } : op;
    }
    return op;
  });

  const record: LastBatch = {
    planId: plan.id,
    inverse: resolvedInverse,
    appliedAt: new Date().toISOString(),
    backup
  };
  await writeFile(lastBatchPath(), JSON.stringify(record, null, 2));

  return {
    text:
      `Applied ${summarizeOps(resolved.ops)}.\n` +
      `Backup at ${backup}\n` +
      `Run undo_last_batch to reverse this.`,
    structured: { applied: true, opCount: resolved.ops.length, backup, rows }
  };
}

function toolResult(result: { text: string; structured: Record<string, unknown>; isError?: boolean }) {
  const payload: {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent: Record<string, unknown>;
    isError?: boolean;
  } = {
    content: [{ type: 'text' as const, text: result.text }],
    structuredContent: result.structured
  };
  if (result.isError) payload.isError = true;
  return payload;
}

export function registerWriteTools(server: McpServer, ctx: WriteCtx): void {
  server.registerTool(
    'propose_reorg',
    {
      title: 'Propose a bookmark reorganization',
      description:
        'Validate a reorganization plan and return it for review. Applies nothing. ' +
        'Pass a plan you built, or set generate to "duplicates" or "dead_links" to have one built for you. ' +
        'The result renders as an interactive diff the user can prune before applying.',
      inputSchema: z.object({
        plan: PlanSchema.optional(),
        generate: z.enum(['duplicates', 'dead_links']).optional(),
        note: z.string().optional()
      }),
      _meta: { ui: { resourceUri: 'ui://bookmarks/review' } }
    },
    async ({ plan, generate, note }) => {
      const index = await ctx.source.get();

      let candidate: Plan | undefined = plan;
      if (!candidate && generate === 'duplicates') candidate = duplicatePlan(index);
      if (!candidate && generate === 'dead_links') {
        candidate = await deadLinkPlan(index, withConcurrency(httpLivenessCheck(), 8));
      }
      if (!candidate) {
        return toolResult({
          isError: true,
          text: 'Provide either a plan or a generate mode.',
          structured: { errors: ['no plan and no generate mode'] }
        });
      }
      if (note !== undefined) candidate.note = note;

      const validation = validatePlan(candidate, index);
      const rows = planToRows(candidate, index);
      const errors = validation.ok ? [] : validation.errors;

      return toolResult({
        text: validation.ok
          ? `${candidate.note ?? summarizeOps(candidate.ops)}\nReview the ${rows.length} changes, then apply.`
          : `Plan has ${errors.length} problems:\n${errors.map(e => `  ${e}`).join('\n')}`,
        structured: { plan: candidate, rows, errors, valid: validation.ok }
      });
    }
  );

  server.registerTool(
    'apply_plan',
    {
      title: 'Apply a bookmark plan',
      description:
        'Apply a reorganization plan through the Chrome extension. Takes a backup first and records ' +
        'an undo. Soft deletes move to an _MCP Trash folder rather than being destroyed.',
      inputSchema: z.object({
        plan: PlanSchema,
        dry_run: z.boolean().optional()
      }),
      _meta: { ui: { resourceUri: 'ui://bookmarks/review' } }
    },
    async ({ plan, dry_run = false }) => toolResult(await applyPlanInternal(ctx, plan, dry_run))
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create a bookmark folder',
      description: 'Create one folder inside an existing folder.',
      inputSchema: z.object({
        parentId: z.string(),
        title: z.string().min(1)
      })
    },
    async ({ parentId, title }) =>
      toolResult(
        await applyPlanInternal(
          ctx,
          { id: `create-folder-${Date.now()}`, ops: [{ op: 'create_folder', tempId: 'f1', parentId, title }] },
          false
        )
      )
  );

  server.registerTool(
    'move_bookmarks',
    {
      title: 'Move bookmarks',
      description: 'Move one or more bookmarks into an existing folder.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1),
        parentId: z.string()
      })
    },
    async ({ ids, parentId }) =>
      toolResult(
        await applyPlanInternal(
          ctx,
          { id: `move-${Date.now()}`, ops: ids.map(id => ({ op: 'move' as const, id, parentId })) },
          false
        )
      )
  );

  server.registerTool(
    'update_bookmark',
    {
      title: 'Update a bookmark',
      description: 'Change the title or url of one bookmark.',
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        url: z.string().optional()
      })
    },
    async ({ id, title, url }) => {
      const op: Op = { op: 'update', id };
      if (title !== undefined) op.title = title;
      if (url !== undefined) op.url = url;
      return toolResult(await applyPlanInternal(ctx, { id: `update-${Date.now()}`, ops: [op] }, false));
    }
  );

  server.registerTool(
    'delete_bookmarks',
    {
      title: 'Delete bookmarks',
      description:
        'Delete one or more bookmarks. By default they move to an _MCP Trash folder. ' +
        'Set hard to true to remove them permanently.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1),
        hard: z.boolean().optional()
      })
    },
    async ({ ids, hard = false }) =>
      toolResult(
        await applyPlanInternal(
          ctx,
          { id: `delete-${Date.now()}`, ops: ids.map(id => ({ op: 'delete' as const, id, hard })) },
          false
        )
      )
  );

  server.registerTool(
    'undo_last_batch',
    {
      title: 'Undo the last applied batch',
      description: 'Reverse the most recent applied plan. Only the most recent batch can be undone.',
      inputSchema: z.object({})
    },
    async () => {
      const record = await readLastBatch();
      if (!record) {
        return toolResult({
          isError: true,
          text: 'No batch has been applied since the server started, so there is nothing to undo.',
          structured: { undone: false }
        });
      }

      try {
        await ctx.bridge.apply(record.inverse);
      } catch (err) {
        return toolResult({
          isError: true,
          text: `Undo failed: ${(err as Error).message}\nThe pre-batch backup is at ${record.backup}`,
          structured: { undone: false, backup: record.backup }
        });
      }

      await unlink(lastBatchPath()).catch(() => {});
      return toolResult({
        text: `Reversed plan ${record.planId} applied at ${record.appliedAt}. ${summarizeOps(record.inverse)}.`,
        structured: { undone: true, planId: record.planId }
      });
    }
  );

  server.registerTool(
    'bridge_status',
    {
      title: 'Check the extension connection',
      description: 'Report whether the Chrome extension is connected, which is required for any write.',
      inputSchema: z.object({})
    },
    async () => {
      const connected = ctx.bridge.isConnected();
      return toolResult({
        text: connected
          ? 'The Chrome extension is connected. Writes will work.'
          : 'The Chrome extension is not connected. Reads work, writes will fail.',
        structured: { connected }
      });
    }
  );
}
