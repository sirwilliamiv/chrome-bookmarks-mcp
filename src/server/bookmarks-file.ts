import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BookmarkIndex, BookmarkNode, FolderNode } from './types.js';

export const DEFAULT_BOOKMARKS_PATH = join(
  homedir(),
  'Library/Application Support/Google/Chrome/Default/Bookmarks'
);

/** Chrome stores timestamps as microseconds since 1601-01-01 UTC. */
export function chromeTimeToMs(v: string): number {
  if (!v) return 0;
  return Number(BigInt(v) / 1000n) - 11644473600000;
}

const ROOT_LABELS: Record<string, string> = {
  bookmark_bar: 'Bookmarks bar',
  other: 'Other bookmarks',
  synced: 'Mobile bookmarks'
};

interface RawNode {
  id?: string | number;
  guid?: string;
  name?: string;
  type?: string;
  url?: string;
  date_added?: string;
  children?: RawNode[];
}

export function parseBookmarks(json: unknown): BookmarkIndex {
  const roots = (json as { roots?: Record<string, unknown> }).roots ?? {};
  const bookmarks: BookmarkNode[] = [];
  const folders: FolderNode[] = [];

  // Returns the recursive bookmark count for this subtree. The folder record is
  // pushed after recursing so totalCount is already known.
  function walk(node: RawNode, parentId: string | null, path: string, index: number): number {
    let direct = 0;
    let total = 0;
    const children = Array.isArray(node.children) ? node.children : [];

    children.forEach((child, index) => {
      if (child.type === 'url') {
        direct++;
        total++;
        bookmarks.push({
          id: String(child.id),
          guid: String(child.guid ?? ''),
          title: String(child.name ?? ''),
          url: String(child.url ?? ''),
          parentId: String(node.id),
          index,
          folderPath: path,
          dateAdded: chromeTimeToMs(String(child.date_added ?? '0'))
        });
      } else {
        total += walk(child, String(node.id), `${path}/${child.name}`, index);
      }
    });

    folders.push({
      id: String(node.id),
      guid: String(node.guid ?? ''),
      title: String(node.name ?? ''),
      parentId,
      index,
      folderPath: path,
      bookmarkCount: direct,
      totalCount: total
    });
    return total;
  }

  for (const [key, root] of Object.entries(roots)) {
    if (!root || typeof root !== 'object' || !('children' in (root as object))) continue;
    const raw = root as RawNode;
    const label = ROOT_LABELS[key] ?? String(raw.name ?? key);
    walk(raw, null, `/${label}`, 0);
  }

  return {
    bookmarks,
    folders,
    byId: new Map(bookmarks.map(b => [b.id, b])),
    byGuid: new Map(bookmarks.map(b => [b.guid, b])),
    folderById: new Map(folders.map(f => [f.id, f])),
    loadedAt: Date.now()
  };
}

export class BookmarksSource {
  private cached: BookmarkIndex | null = null;
  private cachedMtime = 0;

  constructor(
    readonly path: string = process.env.CHROME_BOOKMARKS_PATH ?? DEFAULT_BOOKMARKS_PATH
  ) {}

  async get(): Promise<BookmarkIndex> {
    let mtime: number;
    try {
      mtime = (await stat(this.path)).mtimeMs;
    } catch {
      throw new Error(
        `Chrome bookmarks file not found at ${this.path}. Set CHROME_BOOKMARKS_PATH to override.`
      );
    }
    if (this.cached && mtime === this.cachedMtime) return this.cached;
    const raw = await readFile(this.path, 'utf8');
    this.cached = parseBookmarks(JSON.parse(raw));
    this.cachedMtime = mtime;
    return this.cached;
  }
}
