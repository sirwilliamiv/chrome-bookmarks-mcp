/**
 * Applies a batch of bookmark ops against anything shaped like chrome.bookmarks.
 * Deliberately free of Chrome globals so Node can test it directly.
 *
 * Ops may reference a node created earlier in the same batch as "temp:<tempId>".
 * Soft deletes never reach here: the server rewrites them into moves to the
 * _MCP Trash folder before sending the batch.
 */

const TEMP_PREFIX = 'temp:';

export class OpFailure extends Error {
  constructor(message, index, appliedCount) {
    super(message);
    this.name = 'OpFailure';
    this.index = index;
    this.appliedCount = appliedCount;
  }
}

function resolveId(ref, tempIds) {
  if (typeof ref !== 'string' || !ref.startsWith(TEMP_PREFIX)) return ref;
  const key = ref.slice(TEMP_PREFIX.length);
  const real = tempIds.get(key);
  if (!real) throw new Error(`unresolved temp reference ${ref}`);
  return real;
}

export async function applyOps(ops, bookmarks) {
  const applied = [];
  const tempIds = new Map();

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    try {
      switch (op.op) {
        case 'create_folder': {
          const created = await bookmarks.create({
            parentId: resolveId(op.parentId, tempIds),
            title: op.title
          });
          tempIds.set(op.tempId, created.id);
          applied.push({ tempId: op.tempId, newId: created.id });
          break;
        }
        case 'create_bookmark': {
          const payload = {
            parentId: resolveId(op.parentId, tempIds),
            title: op.title,
            url: op.url
          };
          if (typeof op.index === 'number') payload.index = op.index;
          const created = await bookmarks.create(payload);
          tempIds.set(op.tempId, created.id);
          applied.push({ tempId: op.tempId, newId: created.id });
          break;
        }
        case 'move': {
          const destination = { parentId: resolveId(op.parentId, tempIds) };
          if (typeof op.index === 'number') destination.index = op.index;
          await bookmarks.move(resolveId(op.id, tempIds), destination);
          applied.push({});
          break;
        }
        case 'update': {
          const changes = {};
          if (op.title !== undefined) changes.title = op.title;
          if (op.url !== undefined) changes.url = op.url;
          await bookmarks.update(resolveId(op.id, tempIds), changes);
          applied.push({});
          break;
        }
        case 'delete': {
          const id = resolveId(op.id, tempIds);
          if (bookmarks.removeTree) await bookmarks.removeTree(id).catch(() => bookmarks.remove(id));
          else await bookmarks.remove(id);
          applied.push({});
          break;
        }
        default:
          throw new Error(`unknown op ${op.op}`);
      }
    } catch (err) {
      throw new OpFailure(err && err.message ? err.message : String(err), index, applied.length);
    }
  }

  return applied;
}
