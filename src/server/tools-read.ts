import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { BookmarkIndex, BookmarkNode } from './types.js';
import type { BookmarksSource } from './bookmarks-file.js';
import type { FuzzyRanker } from './search/fuzzy.js';
import type { SemanticRanker } from './search/semantic.js';
import type { HybridRanker } from './search/hybrid.js';
import type { ScoredHit } from './search/types.js';

export interface FolderTreeNode {
  id: string;
  title: string;
  folderPath: string;
  bookmarkCount: number;
  totalCount: number;
  children: FolderTreeNode[];
}

export interface ReadCtx {
  source: BookmarksSource;
  fuzzy: FuzzyRanker;
  semantic: SemanticRanker;
  hybrid: HybridRanker;
}

export function folderTree(index: BookmarkIndex): FolderTreeNode[] {
  const byParent = new Map<string | null, typeof index.folders>();
  for (const folder of index.folders) {
    const bucket = byParent.get(folder.parentId) ?? [];
    bucket.push(folder);
    byParent.set(folder.parentId, bucket);
  }

  const build = (parentId: string | null): FolderTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .map(folder => ({
        id: folder.id,
        title: folder.title,
        folderPath: folder.folderPath,
        bookmarkCount: folder.bookmarkCount,
        totalCount: folder.totalCount,
        children: build(folder.id)
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

  return build(null);
}

export function bookmarksInFolder(
  index: BookmarkIndex,
  folderPath: string,
  offset: number,
  limit: number
): BookmarkNode[] {
  return index.bookmarks
    .filter(b => b.folderPath === folderPath)
    .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
    .slice(offset, offset + limit);
}

function hitsPayload(hits: ScoredHit[]) {
  return hits.map(h => ({
    id: h.bookmark.id,
    guid: h.bookmark.guid,
    title: h.bookmark.title,
    url: h.bookmark.url,
    folderPath: h.bookmark.folderPath,
    score: Number(h.score.toFixed(5))
  }));
}

function summarize(hits: ScoredHit[]): string {
  if (!hits.length) return 'No matching bookmarks.';
  return hits
    .map((h, i) => `${i + 1}. ${h.bookmark.title}\n   ${h.bookmark.url}\n   in ${h.bookmark.folderPath}`)
    .join('\n');
}

export function registerReadTools(server: McpServer, ctx: ReadCtx): void {
  server.registerTool(
    'list_folders',
    {
      title: 'List bookmark folders',
      description: 'List the Chrome bookmark folder tree with per-folder counts.',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: 'ui://bookmarks/explorer' } }
    },
    async () => {
      const index = await ctx.source.get();
      const tree = folderTree(index);
      return {
        content: [
          {
            type: 'text' as const,
            text: `${index.bookmarks.length} bookmarks in ${index.folders.length} folders.\n${JSON.stringify(tree, null, 2)}`
          }
        ],
        structuredContent: { tree, totalBookmarks: index.bookmarks.length }
      };
    }
  );

  server.registerTool(
    'list_bookmarks',
    {
      title: 'List bookmarks in a folder',
      description: 'List the bookmarks directly inside one folder path. Does not recurse.',
      inputSchema: z.object({
        folder: z.string().describe('Exact folder path, for example /Bookmarks bar/Dev'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional()
      }),
      _meta: { ui: { resourceUri: 'ui://bookmarks/explorer' } }
    },
    async ({ folder, offset = 0, limit = 100 }) => {
      const index = await ctx.source.get();
      const rows = bookmarksInFolder(index, folder, offset, limit);
      const total = index.bookmarks.filter(b => b.folderPath === folder).length;
      return {
        content: [
          {
            type: 'text' as const,
            text: rows.length
              ? rows.map(b => `${b.title}\n   ${b.url}`).join('\n')
              : `No bookmarks directly in ${folder}.`
          }
        ],
        structuredContent: { folder, offset, limit, total, bookmarks: rows }
      };
    }
  );

  server.registerTool(
    'get_bookmark',
    {
      title: 'Get one bookmark',
      description: 'Fetch a single bookmark by its Chrome id or guid.',
      inputSchema: z.object({
        id: z.string().optional(),
        guid: z.string().optional()
      })
    },
    async ({ id, guid }) => {
      if (!id && !guid) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Provide either id or guid.' }]
        };
      }
      const index = await ctx.source.get();
      const found = id ? index.byId.get(id) : index.byGuid.get(guid!);
      if (!found) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `No bookmark found for ${id ?? guid}.` }]
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(found, null, 2) }],
        structuredContent: { bookmark: found }
      };
    }
  );

  server.registerTool(
    'search_bookmarks',
    {
      title: 'Search bookmarks',
      description:
        'Search bookmarks by meaning and by text. Use mode "auto" unless you have a reason not to. ' +
        'Semantic mode finds bookmarks whose titles never contain the query words.',
      inputSchema: z.object({
        query: z.string().min(1),
        mode: z.enum(['auto', 'fuzzy', 'semantic']).optional(),
        folder: z.string().optional().describe('Restrict to bookmarks under this folder path prefix'),
        limit: z.number().int().min(1).max(200).optional()
      }),
      _meta: { ui: { resourceUri: 'ui://bookmarks/explorer' } }
    },
    async ({ query, mode = 'auto', folder, limit = 25 }) => {
      const index = await ctx.source.get();
      const pool = folder ? index.bookmarks.filter(b => b.folderPath.startsWith(folder)) : index.bookmarks;

      let hits: ScoredHit[];
      let degraded = false;
      let note: string | undefined;

      if (mode === 'fuzzy') {
        hits = await ctx.fuzzy.rank(query, pool, limit);
      } else if (mode === 'semantic') {
        hits = await ctx.semantic.rank(query, pool, limit);
      } else {
        const result = await ctx.hybrid.search(query, pool, limit);
        hits = result.hits;
        degraded = result.degraded;
        note = result.note;
      }

      const structured: Record<string, unknown> = {
        query,
        mode,
        searched: pool.length,
        degraded,
        hits: hitsPayload(hits)
      };
      if (note !== undefined) structured.note = note;

      return {
        content: [
          { type: 'text' as const, text: (note ? `${note}\n\n` : '') + summarize(hits) }
        ],
        structuredContent: structured
      };
    }
  );
}
