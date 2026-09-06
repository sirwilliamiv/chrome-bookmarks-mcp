import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BookmarkIndex, BookmarkNode, FolderNode } from './types.js';

export const BROWSERS = ['chrome', 'chromium', 'brave', 'edge', 'vivaldi'] as const;
export type Browser = (typeof BROWSERS)[number];

/** Where each Chromium fork keeps its user data, per platform. */
const VENDOR_DIRS: Record<Browser, { darwin: string; win32: string; linux: string }> = {
  chrome: { darwin: 'Google/Chrome', win32: 'Google/Chrome/User Data', linux: 'google-chrome' },
  chromium: { darwin: 'Chromium', win32: 'Chromium/User Data', linux: 'chromium' },
  brave: {
    darwin: 'BraveSoftware/Brave-Browser',
    win32: 'BraveSoftware/Brave-Browser/User Data',
    linux: 'BraveSoftware/Brave-Browser'
  },
  edge: { darwin: 'Microsoft Edge', win32: 'Microsoft/Edge/User Data', linux: 'microsoft-edge' },
  vivaldi: { darwin: 'Vivaldi', win32: 'Vivaldi/User Data', linux: 'vivaldi' }
};

export interface BookmarksPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** %LOCALAPPDATA% on Windows */
  localAppData?: string;
  /** $XDG_CONFIG_HOME on Linux */
  configHome?: string;
  browser?: string;
  profile?: string;
}

/**
 * The Bookmarks file for a browser and profile on this platform. Every part is
 * overridable so the mapping can be unit tested without a real browser.
 */
export function defaultBookmarksPath(opts: BookmarksPathOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const browser = (opts.browser ?? process.env.CHROME_BOOKMARKS_BROWSER ?? 'chrome').toLowerCase();
  const profile = opts.profile ?? process.env.CHROME_PROFILE ?? 'Default';

  const vendor = VENDOR_DIRS[browser as Browser];
  if (!vendor) {
    throw new Error(
      `Unknown browser "${browser}". CHROME_BOOKMARKS_BROWSER must be one of ${BROWSERS.join(', ')}, ` +
        `or set CHROME_BOOKMARKS_PATH to the Bookmarks file directly.`
    );
  }

  let base: string;
  if (platform === 'darwin') {
    base = join(home, 'Library/Application Support', vendor.darwin);
  } else if (platform === 'win32') {
    const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
    base = join(localAppData, vendor.win32);
  } else {
    const configHome = opts.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config');
    base = join(configHome, vendor.linux);
  }
  return join(base, profile, 'Bookmarks');
}

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
    readonly path: string = process.env.CHROME_BOOKMARKS_PATH ?? defaultBookmarksPath()
  ) {}

  async get(): Promise<BookmarkIndex> {
    let mtime: number;
    try {
      mtime = (await stat(this.path)).mtimeMs;
    } catch {
      throw new Error(
        `Bookmarks file not found at ${this.path}. Set CHROME_BOOKMARKS_BROWSER (${BROWSERS.join('|')}), ` +
          `CHROME_PROFILE, or CHROME_BOOKMARKS_PATH to point at the right file.`
      );
    }
    if (this.cached && mtime === this.cachedMtime) return this.cached;
    const raw = await readFile(this.path, 'utf8');
    this.cached = parseBookmarks(JSON.parse(raw));
    this.cachedMtime = mtime;
    return this.cached;
  }
}
