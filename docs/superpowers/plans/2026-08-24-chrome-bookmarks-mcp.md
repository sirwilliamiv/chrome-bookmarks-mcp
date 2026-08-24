# chrome-bookmarks-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server that lets Claude search ~2,000 Chrome bookmarks and reorganize them in bulk, with a visual approval UI rendered inside Claude.

**Architecture:** Reads parse the Chrome `Bookmarks` JSON file directly into an in-memory index. Writes go through a companion MV3 extension over a localhost WebSocket, because Chrome overwrites external edits to that file. Two MCP App views (`ui://` resources) render an explorer and a plan-review diff inside the Claude client.

**Tech Stack:** TypeScript, Node 22, pnpm 10, `@modelcontextprotocol/server` (SDK v2), `@modelcontextprotocol/ext-apps`, `@huggingface/transformers` (local MiniLM embeddings), `ws`, `vitest`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-08-24-chrome-bookmarks-mcp-design.md`

## Global Constraints

- Node 22, pnpm 10. ESM throughout (`"type": "module"`). All relative imports carry explicit `.js` extensions.
- MCP SDK v2 import paths: `McpServer` from `@modelcontextprotocol/server`, `serveStdio` from `@modelcontextprotocol/server/stdio`. Tools registered with `server.registerTool(name, { description, inputSchema: z.object({...}) }, handler)`.
- MCP Apps protocol version `2026-01-26`. UI resources MUST use mimeType exactly `text/html;profile=mcp-app`. Tools link to them via `_meta: { ui: { resourceUri: "ui://..." } }`. Never use the deprecated `_meta["ui/resourceUri"]`.
- View CSP is `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'`. Views MUST be single self-contained HTML files with inline CSS and JS. No remote fonts, no remote favicons, no `fetch`.
- Bookmarks path: `~/Library/Application Support/Google/Chrome/Default/Bookmarks`, overridable via `CHROME_BOOKMARKS_PATH`.
- Chrome timestamps are microseconds since 1601-01-01 UTC. Convert with `Number(BigInt(v) / 1000n) - 11644473600000`.
- Server state dir: `~/.chrome-bookmarks-mcp/` holding `embeddings.json`, `backups/`, `token`, `last-batch.json`.
- Never write to the Bookmarks file. Reads only. All mutations go through the extension.
- No em dashes in any output, code, comment, commit message, or UI copy.
- Conventional commits. No AI attribution trailers.

---

### Task 1: Scaffold and bookmarks file parser

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/server/types.ts`
- Create: `src/server/bookmarks-file.ts`
- Create: `tests/fixtures/Bookmarks.json`
- Test: `tests/bookmarks-file.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type BookmarkNode = { id, guid, title, url, parentId, index, folderPath, dateAdded }` (all strings except `index: number`, `dateAdded: number`)
  - `type FolderNode = { id, guid, title, parentId: string | null, folderPath, bookmarkCount, totalCount }`
  - `type BookmarkIndex = { bookmarks, folders, byId: Map, byGuid: Map, folderById: Map, loadedAt: number }`
  - `parseBookmarks(json: unknown): BookmarkIndex`
  - `chromeTimeToMs(v: string): number`
  - `class BookmarksSource { constructor(path?: string); get(): Promise<BookmarkIndex> }` reloading on mtime change

- [ ] **Step 1: Init the package**

```bash
cd /Users/b/Desktop/code/chrome-bookmarks-mcp
pnpm init
pnpm add @modelcontextprotocol/server zod ws
pnpm add -D typescript vitest @types/node @types/ws esbuild
```

Set in `package.json`: `"type": "module"`, `"scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc --noEmit" }`.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Write the fixture**

Create `tests/fixtures/Bookmarks.json` with a `roots` object containing `bookmark_bar`, `other`, and `synced`. Include: two bookmarks at the bar root, a folder `Dev` holding two bookmarks, a nested folder `Dev/Rust` holding one, a duplicate URL appearing in both `Dev` and `other`, and one bookmark with a unicode title (`"Café résumé"`). Use realistic Chrome fields: `date_added` as a microsecond string, `guid`, `id`, `name`, `type`, `url`.

- [ ] **Step 3: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks, chromeTimeToMs } from '../src/server/bookmarks-file.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'));

describe('parseBookmarks', () => {
  it('flattens every bookmark across all roots', () => {
    const index = parseBookmarks(fixture);
    expect(index.bookmarks).toHaveLength(7);
  });

  it('builds a human readable folder path', () => {
    const index = parseBookmarks(fixture);
    const rust = index.bookmarks.find(b => b.folderPath.endsWith('/Rust'));
    expect(rust?.folderPath).toBe('/Bookmarks bar/Dev/Rust');
  });

  it('counts folders recursively and directly', () => {
    const index = parseBookmarks(fixture);
    const dev = index.folders.find(f => f.title === 'Dev')!;
    expect(dev.bookmarkCount).toBe(2);
    expect(dev.totalCount).toBe(3);
  });

  it('indexes by id and guid', () => {
    const index = parseBookmarks(fixture);
    const first = index.bookmarks[0];
    expect(index.byId.get(first.id)).toBe(first);
    expect(index.byGuid.get(first.guid)).toBe(first);
  });

  it('preserves unicode titles', () => {
    const index = parseBookmarks(fixture);
    expect(index.bookmarks.some(b => b.title === 'Café résumé')).toBe(true);
  });
});

describe('chromeTimeToMs', () => {
  it('converts the 1601 microsecond epoch to the unix millisecond epoch', () => {
    expect(chromeTimeToMs('13079403021286781')).toBe(1434929421286);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run tests/bookmarks-file.test.ts`
Expected: FAIL, cannot resolve `../src/server/bookmarks-file.js`.

- [ ] **Step 5: Implement types and parser**

`src/server/types.ts` holds the four types from the Interfaces block above.

`src/server/bookmarks-file.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BookmarkIndex, BookmarkNode, FolderNode } from './types.js';

export const DEFAULT_BOOKMARKS_PATH = join(
  homedir(),
  'Library/Application Support/Google/Chrome/Default/Bookmarks'
);

export function chromeTimeToMs(v: string): number {
  if (!v) return 0;
  return Number(BigInt(v) / 1000n) - 11644473600000;
}

const ROOT_LABELS: Record<string, string> = {
  bookmark_bar: 'Bookmarks bar',
  other: 'Other bookmarks',
  synced: 'Mobile bookmarks'
};

export function parseBookmarks(json: unknown): BookmarkIndex {
  const roots = (json as { roots?: Record<string, unknown> }).roots ?? {};
  const bookmarks: BookmarkNode[] = [];
  const folders: FolderNode[] = [];

  // walk returns the recursive bookmark count for the subtree
  function walk(node: any, parentId: string | null, path: string): number {
    let direct = 0;
    let total = 0;
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child: any, index: number) => {
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
        total += walk(child, String(node.id), `${path}/${child.name}`);
      }
    });
    folders.push({
      id: String(node.id),
      guid: String(node.guid ?? ''),
      title: String(node.name ?? ''),
      parentId,
      folderPath: path,
      bookmarkCount: direct,
      totalCount: total
    });
    return total;
  }

  for (const [key, root] of Object.entries(roots)) {
    if (!root || typeof root !== 'object' || !('children' in (root as object))) continue;
    const label = ROOT_LABELS[key] ?? String((root as any).name ?? key);
    walk(root, null, `/${label}`);
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

  constructor(private readonly path: string = process.env.CHROME_BOOKMARKS_PATH ?? DEFAULT_BOOKMARKS_PATH) {}

  async get(): Promise<BookmarkIndex> {
    let mtime: number;
    try {
      mtime = (await stat(this.path)).mtimeMs;
    } catch {
      throw new Error(`Chrome bookmarks file not found at ${this.path}. Set CHROME_BOOKMARKS_PATH to override.`);
    }
    if (this.cached && mtime === this.cachedMtime) return this.cached;
    const raw = await readFile(this.path, 'utf8');
    this.cached = parseBookmarks(JSON.parse(raw));
    this.cachedMtime = mtime;
    return this.cached;
  }
}
```

Note the walk pushes the folder record after recursing so `totalCount` is populated.

- [ ] **Step 6: Run tests until green**

Run: `pnpm vitest run tests/bookmarks-file.test.ts`
Expected: PASS, 6 tests.

Adjust the expected count in the first test to match the fixture you actually wrote.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: parse chrome bookmarks file into a flat index"
```

---

### Task 2: Fuzzy ranker

**Files:**
- Create: `src/server/search/types.ts`
- Create: `src/server/search/fuzzy.ts`
- Test: `tests/fuzzy.test.ts`

**Interfaces:**
- Consumes: `BookmarkNode` from Task 1
- Produces:
  - `type ScoredHit = { bookmark: BookmarkNode; score: number }`
  - `interface Ranker { rank(query: string, pool: BookmarkNode[], limit: number): Promise<ScoredHit[]> }`
  - `class FuzzyRanker implements Ranker`
  - `scoreOne(query: string, b: BookmarkNode): number` exported for testing

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { scoreOne, FuzzyRanker } from '../src/server/search/fuzzy.js';
import type { BookmarkNode } from '../src/server/types.js';

const mk = (title: string, url: string, folderPath = '/Bookmarks bar'): BookmarkNode => ({
  id: title, guid: title, title, url, parentId: '1', index: 0, folderPath, dateAdded: 0
});

describe('scoreOne', () => {
  it('ranks an exact title match above a prefix match', () => {
    expect(scoreOne('rust', mk('rust', 'https://x.com')))
      .toBeGreaterThan(scoreOne('rust', mk('rust book', 'https://x.com')));
  });

  it('ranks a title match above a url-only match', () => {
    expect(scoreOne('rust', mk('rust book', 'https://x.com')))
      .toBeGreaterThan(scoreOne('rust', mk('The Book', 'https://rust-lang.org')));
  });

  it('ranks a url match above a folder-only match', () => {
    expect(scoreOne('rust', mk('The Book', 'https://rust-lang.org')))
      .toBeGreaterThan(scoreOne('rust', mk('The Book', 'https://x.com', '/Bookmarks bar/Rust')));
  });

  it('is case insensitive', () => {
    expect(scoreOne('RUST', mk('Rust', 'https://x.com'))).toBe(scoreOne('rust', mk('Rust', 'https://x.com')));
  });

  it('scores a non-match at zero', () => {
    expect(scoreOne('kubernetes', mk('Rust', 'https://rust-lang.org'))).toBe(0);
  });
});

describe('FuzzyRanker', () => {
  it('returns only matches, best first, capped at the limit', async () => {
    const pool = [
      mk('Rust', 'https://rust-lang.org'),
      mk('Rust by Example', 'https://doc.rust-lang.org'),
      mk('Python', 'https://python.org')
    ];
    const hits = await new FuzzyRanker().rank('rust', pool, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].bookmark.title).toBe('Rust');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/fuzzy.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/server/search/types.ts` holds `ScoredHit` and `Ranker`.

`src/server/search/fuzzy.ts`:

```ts
import type { BookmarkNode } from '../types.js';
import type { Ranker, ScoredHit } from './types.js';

export function scoreOne(query: string, b: BookmarkNode): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const title = b.title.toLowerCase();
  const url = b.url.toLowerCase();
  const folder = b.folderPath.toLowerCase();

  let score = 0;
  if (title === q) score = 100;
  else if (title.startsWith(q)) score = 80;
  else if (title.includes(q)) score = 60;
  else if (url.includes(q)) score = 40;
  else if (folder.includes(q)) score = 20;
  else return 0;

  // small tiebreaker so shorter titles win when the tier is equal
  return score + Math.max(0, 10 - title.length / 20);
}

export class FuzzyRanker implements Ranker {
  async rank(query: string, pool: BookmarkNode[], limit: number): Promise<ScoredHit[]> {
    const hits: ScoredHit[] = [];
    for (const bookmark of pool) {
      const score = scoreOne(query, bookmark);
      if (score > 0) hits.push({ bookmark, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/fuzzy.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: fuzzy bookmark ranker over title, url, and folder path"
```

---

### Task 3: Semantic ranker and hybrid fusion

**Files:**
- Create: `src/server/search/semantic.ts`
- Create: `src/server/search/hybrid.ts`
- Create: `src/server/paths.ts`
- Test: `tests/hybrid.test.ts`, `tests/semantic-cache.test.ts`

**Interfaces:**
- Consumes: `Ranker`, `ScoredHit`, `FuzzyRanker` from Task 2
- Produces:
  - `class SemanticRanker implements Ranker` with `constructor(cachePath: string)` and `isReady(): boolean`
  - `embedText(texts: string[]): Promise<number[][]>`
  - `cosine(a: number[], b: number[]): number`
  - `type EmbeddingCache = Record<string, { hash: string; vec: number[] }>` keyed by guid
  - `loadCache(path)` / `saveCache(path, cache)` / `textHash(text: string): string`
  - `fuseRRF(lists: ScoredHit[][], weights: number[], k?: number): ScoredHit[]`
  - `class HybridRanker implements Ranker` with `constructor(fuzzy: Ranker, semantic: SemanticRanker)`
  - `stateDir()` and `statePath(...parts)` in `paths.ts`

- [ ] **Step 1: Add the dependency**

```bash
pnpm add @huggingface/transformers
```

- [ ] **Step 2: Write the failing test for fusion and cosine**

```ts
import { describe, it, expect } from 'vitest';
import { fuseRRF } from '../src/server/search/hybrid.js';
import { cosine } from '../src/server/search/semantic.js';
import type { BookmarkNode } from '../src/server/types.js';
import type { ScoredHit } from '../src/server/search/types.js';

const mk = (title: string): BookmarkNode => ({
  id: title, guid: title, title, url: 'https://x.com', parentId: '1', index: 0, folderPath: '/', dateAdded: 0
});
const hit = (title: string, score: number): ScoredHit => ({ bookmark: mk(title), score });

describe('cosine', () => {
  it('is 1 for identical vectors', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('fuseRRF', () => {
  it('promotes an item that appears in both lists over one that tops only a single list', () => {
    const fuzzy = [hit('a', 100), hit('b', 90)];
    const semantic = [hit('c', 1), hit('b', 0.9)];
    const fused = fuseRRF([fuzzy, semantic], [1, 1]);
    expect(fused[0].bookmark.title).toBe('b');
  });

  it('dedupes by bookmark id', () => {
    const fused = fuseRRF([[hit('a', 1)], [hit('a', 1)]], [1, 1]);
    expect(fused).toHaveLength(1);
  });

  it('respects list weights', () => {
    const fuzzy = [hit('a', 1)];
    const semantic = [hit('b', 1)];
    expect(fuseRRF([fuzzy, semantic], [10, 1])[0].bookmark.title).toBe('a');
    expect(fuseRRF([fuzzy, semantic], [1, 10])[0].bookmark.title).toBe('b');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run tests/hybrid.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement paths, semantic ranker, and fusion**

`src/server/paths.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function stateDir(): string {
  const dir = process.env.CHROME_BOOKMARKS_MCP_HOME ?? join(homedir(), '.chrome-bookmarks-mcp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(...parts: string[]): string {
  return join(stateDir(), ...parts);
}
```

`src/server/search/semantic.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BookmarkNode } from '../types.js';
import type { Ranker, ScoredHit } from './types.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

export type EmbeddingCache = Record<string, { hash: string; vec: number[] }>;

export function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function embedTextOf(b: BookmarkNode): string {
  // folder path carries real signal about intent, so it joins the embedded text
  return `${b.title} ${b.folderPath.replaceAll('/', ' ')} ${b.url}`;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function loadCache(path: string): Promise<EmbeddingCache> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as EmbeddingCache;
  } catch {
    return {};
  }
}

export async function saveCache(path: string, cache: EmbeddingCache): Promise<void> {
  await writeFile(path, JSON.stringify(cache));
}

let extractorPromise: Promise<(texts: string[]) => Promise<number[][]>> | null = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const pipe = await pipeline('feature-extraction', MODEL);
      return async (texts: string[]) => {
        const out = await pipe(texts, { pooling: 'mean', normalize: true });
        return out.tolist() as number[][];
      };
    })();
  }
  return extractorPromise;
}

export class SemanticRanker implements Ranker {
  private ready = false;
  private cache: EmbeddingCache = {};

  constructor(private readonly cachePath: string) {}

  isReady(): boolean {
    return this.ready;
  }

  /** Embeds anything new or changed. Safe to call on every search. */
  async warm(pool: BookmarkNode[]): Promise<void> {
    this.cache = Object.keys(this.cache).length ? this.cache : await loadCache(this.cachePath);
    const stale = pool.filter(b => {
      const text = embedTextOf(b);
      const entry = this.cache[b.guid];
      return !entry || entry.hash !== textHash(text);
    });
    if (stale.length) {
      const extract = await getExtractor();
      const batchSize = 64;
      for (let i = 0; i < stale.length; i += batchSize) {
        const batch = stale.slice(i, i + batchSize);
        const vecs = await extract(batch.map(embedTextOf));
        batch.forEach((b, j) => {
          this.cache[b.guid] = { hash: textHash(embedTextOf(b)), vec: vecs[j] };
        });
      }
      await saveCache(this.cachePath, this.cache);
    }
    this.ready = true;
  }

  async rank(query: string, pool: BookmarkNode[], limit: number): Promise<ScoredHit[]> {
    await this.warm(pool);
    const extract = await getExtractor();
    const [qv] = await extract([query]);
    const hits: ScoredHit[] = [];
    for (const bookmark of pool) {
      const entry = this.cache[bookmark.guid];
      if (!entry) continue;
      hits.push({ bookmark, score: cosine(qv, entry.vec) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
```

`src/server/search/hybrid.ts`:

```ts
import type { Ranker, ScoredHit } from './types.js';
import type { BookmarkNode } from '../types.js';
import type { SemanticRanker } from './semantic.js';

export function fuseRRF(lists: ScoredHit[][], weights: number[], k = 60): ScoredHit[] {
  const scores = new Map<string, { hit: ScoredHit; score: number }>();
  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    list.forEach((hit, rank) => {
      const key = hit.bookmark.id;
      const contribution = weight / (k + rank + 1);
      const existing = scores.get(key);
      if (existing) existing.score += contribution;
      else scores.set(key, { hit, score: contribution });
    });
  });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(entry => ({ bookmark: entry.hit.bookmark, score: entry.score }));
}

export type HybridResult = { hits: ScoredHit[]; degraded: boolean; note?: string };

export class HybridRanker {
  constructor(private readonly fuzzy: Ranker, private readonly semantic: SemanticRanker) {}

  async search(query: string, pool: BookmarkNode[], limit: number): Promise<HybridResult> {
    const fuzzyHits = await this.fuzzy.rank(query, pool, limit * 3);
    try {
      const semanticHits = await this.semantic.rank(query, pool, limit * 3);
      return { hits: fuseRRF([fuzzyHits, semanticHits], [1, 1]).slice(0, limit), degraded: false };
    } catch (err) {
      return {
        hits: fuzzyHits.slice(0, limit),
        degraded: true,
        note: `Semantic search unavailable, fuzzy only. ${(err as Error).message}`
      };
    }
  }
}
```

- [ ] **Step 5: Write the cache test**

```ts
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCache, saveCache, textHash, embedTextOf } from '../src/server/search/semantic.js';
import type { BookmarkNode } from '../src/server/types.js';

describe('embedding cache', () => {
  it('returns an empty cache when the file is missing', async () => {
    expect(await loadCache(join(tmpdir(), 'does-not-exist-cbm.json'))).toEqual({});
  });

  it('round trips', async () => {
    const path = join(tmpdir(), `cbm-cache-${process.pid}.json`);
    await saveCache(path, { g1: { hash: 'abc', vec: [1, 2] } });
    expect(await loadCache(path)).toEqual({ g1: { hash: 'abc', vec: [1, 2] } });
  });

  it('changes the hash when the embedded text changes', () => {
    const base: BookmarkNode = {
      id: '1', guid: 'g', title: 'Rust', url: 'https://x.com',
      parentId: '0', index: 0, folderPath: '/Bookmarks bar', dateAdded: 0
    };
    const renamed = { ...base, title: 'Rust Book' };
    expect(textHash(embedTextOf(base))).not.toBe(textHash(embedTextOf(renamed)));
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `pnpm vitest run`
Expected: PASS. The semantic model is never downloaded by these tests, only the pure functions are exercised.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: local semantic ranker with cached embeddings and rrf hybrid fusion"
```

---

### Task 4: MCP server with read tools

**Files:**
- Create: `src/server/index.ts`
- Create: `src/server/tools-read.ts`
- Test: `tests/tools-read.test.ts`

**Interfaces:**
- Consumes: `BookmarksSource`, `FuzzyRanker`, `SemanticRanker`, `HybridRanker`
- Produces:
  - `type Ctx = { source: BookmarksSource; hybrid: HybridRanker; fuzzy: FuzzyRanker }`
  - `registerReadTools(server: McpServer, ctx: Ctx): void`
  - Pure helpers exported for testing: `folderTree(index): FolderTreeNode[]`, `bookmarksInFolder(index, folderPath, offset, limit)`
  - `type FolderTreeNode = { id, title, folderPath, bookmarkCount, totalCount, children: FolderTreeNode[] }`

- [ ] **Step 1: Write the failing test for the pure helpers**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { folderTree, bookmarksInFolder } from '../src/server/tools-read.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);

describe('folderTree', () => {
  it('nests Rust under Dev', () => {
    const tree = folderTree(index);
    const bar = tree.find(f => f.title === 'Bookmarks bar')!;
    const dev = bar.children.find(f => f.title === 'Dev')!;
    expect(dev.children.map(c => c.title)).toContain('Rust');
  });

  it('carries counts through', () => {
    const bar = folderTree(index).find(f => f.title === 'Bookmarks bar')!;
    const dev = bar.children.find(f => f.title === 'Dev')!;
    expect(dev.totalCount).toBe(3);
  });
});

describe('bookmarksInFolder', () => {
  it('returns only direct children of the folder', () => {
    const rows = bookmarksInFolder(index, '/Bookmarks bar/Dev', 0, 50);
    expect(rows.every(b => b.folderPath === '/Bookmarks bar/Dev')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('paginates', () => {
    expect(bookmarksInFolder(index, '/Bookmarks bar/Dev', 1, 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/tools-read.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `tools-read.ts`**

Implement `folderTree` by grouping `index.folders` on `parentId`, and `bookmarksInFolder` by filtering on exact `folderPath` then slicing. Then register four tools on the passed `McpServer`:

```ts
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

export function registerReadTools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'list_folders',
    {
      description: 'List the Chrome bookmark folder tree with per-folder counts.',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: 'ui://bookmarks/explorer' } }
    },
    async () => {
      const index = await ctx.source.get();
      const tree = folderTree(index);
      return {
        content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }],
        structuredContent: { tree, total: index.bookmarks.length }
      };
    }
  );

  server.registerTool(
    'search_bookmarks',
    {
      description:
        'Search bookmarks by meaning and by text. Use mode "auto" unless you have a reason not to.',
      inputSchema: z.object({
        query: z.string(),
        mode: z.enum(['auto', 'fuzzy', 'semantic']).optional(),
        folder: z.string().optional().describe('Restrict to this folder path prefix'),
        limit: z.number().int().min(1).max(200).optional()
      }),
      _meta: { ui: { resourceUri: 'ui://bookmarks/explorer' } }
    },
    async ({ query, mode = 'auto', folder, limit = 25 }) => {
      const index = await ctx.source.get();
      const pool = folder
        ? index.bookmarks.filter(b => b.folderPath.startsWith(folder))
        : index.bookmarks;
      // implementation dispatches on mode; auto uses ctx.hybrid.search
      // returns { content: [text summary], structuredContent: { hits, degraded, note } }
    }
  );

  // list_bookmarks and get_bookmark follow the same shape, no _meta ui link on get_bookmark
}
```

`list_bookmarks` takes `{ folder: string, offset?: number, limit?: number }`. `get_bookmark` takes `{ id?: string, guid?: string }` and errors if neither is given.

Every tool returns both a text summary (so the model can read it without the view) and `structuredContent` (so the view can render it).

- [ ] **Step 4: Implement `index.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BookmarksSource } from './bookmarks-file.js';
import { FuzzyRanker } from './search/fuzzy.js';
import { SemanticRanker } from './search/semantic.js';
import { HybridRanker } from './search/hybrid.js';
import { statePath } from './paths.js';
import { registerReadTools } from './tools-read.js';

serveStdio(() => {
  const server = new McpServer({ name: 'chrome-bookmarks', version: '0.1.0' });
  const source = new BookmarksSource();
  const fuzzy = new FuzzyRanker();
  const semantic = new SemanticRanker(statePath('embeddings.json'));
  registerReadTools(server, { source, fuzzy, hybrid: new HybridRanker(fuzzy, semantic) });
  return server;
});
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS with no type errors.

- [ ] **Step 6: Smoke test against the real file**

```bash
pnpm build
node -e "
import('./dist/server/bookmarks-file.js').then(async m => {
  const i = await new m.BookmarksSource().get();
  console.log(i.bookmarks.length, 'bookmarks', i.folders.length, 'folders');
});
"
```

Expected: prints roughly 1986 bookmarks.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: mcp server with bookmark read and search tools"
```

---

### Task 5: Plan model, validation, and inverse ops

**Files:**
- Create: `src/server/plan.ts`
- Test: `tests/plan.test.ts`

**Interfaces:**
- Consumes: `BookmarkIndex` from Task 1
- Produces:
  - `type Op = { op: 'create_folder'; tempId: string; parentId: string; title: string } | { op: 'move'; id: string; parentId: string; index?: number } | { op: 'update'; id: string; title?: string; url?: string } | { op: 'delete'; id: string; hard?: boolean }`
  - `type Plan = { id: string; ops: Op[]; note?: string }`
  - `validatePlan(plan: Plan, index: BookmarkIndex): { ok: true } | { ok: false; errors: string[] }`
  - `inverseOps(plan: Plan, index: BookmarkIndex): Op[]`
  - `planToRows(plan: Plan, index: BookmarkIndex): PlanRow[]`
  - `type PlanRow = { kind: 'move' | 'update' | 'delete' | 'create_folder'; id: string; title: string; url?: string; from?: string; to?: string; detail?: string }`

Parent references may be a real folder id or `temp:<tempId>` pointing at a `create_folder` op earlier in the same plan.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { validatePlan, inverseOps, planToRows } from '../src/server/plan.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);
const anyBookmark = index.bookmarks[0];
const devFolder = index.folders.find(f => f.title === 'Dev')!;

describe('validatePlan', () => {
  it('accepts a move to an existing folder', () => {
    const result = validatePlan(
      { id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: devFolder.id }] },
      index
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a move of an unknown bookmark and names the id', () => {
    const result = validatePlan({ id: 'p1', ops: [{ op: 'move', id: 'nope', parentId: devFolder.id }] }, index);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('nope');
  });

  it('rejects a move into an unknown folder', () => {
    const result = validatePlan({ id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: '9999' }] }, index);
    expect(result.ok).toBe(false);
  });

  it('accepts a move into a folder created earlier in the same plan', () => {
    const result = validatePlan(
      {
        id: 'p1',
        ops: [
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'Rust' },
          { op: 'move', id: anyBookmark.id, parentId: 'temp:t1' }
        ]
      },
      index
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a forward reference to a folder created later', () => {
    const result = validatePlan(
      {
        id: 'p1',
        ops: [
          { op: 'move', id: anyBookmark.id, parentId: 'temp:t1' },
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'Rust' }
        ]
      },
      index
    );
    expect(result.ok).toBe(false);
  });
});

describe('inverseOps', () => {
  it('inverts a move back to the original parent and index', () => {
    const inverse = inverseOps({ id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: devFolder.id }] }, index);
    expect(inverse).toEqual([
      { op: 'move', id: anyBookmark.id, parentId: anyBookmark.parentId, index: anyBookmark.index }
    ]);
  });

  it('inverts an update back to the prior title and url', () => {
    const inverse = inverseOps({ id: 'p1', ops: [{ op: 'update', id: anyBookmark.id, title: 'New' }] }, index);
    expect(inverse[0]).toMatchObject({ op: 'update', id: anyBookmark.id, title: anyBookmark.title });
  });

  it('returns inverse ops in reverse order of the plan', () => {
    const plan = {
      id: 'p1',
      ops: [
        { op: 'update' as const, id: anyBookmark.id, title: 'New' },
        { op: 'move' as const, id: anyBookmark.id, parentId: devFolder.id }
      ]
    };
    expect(inverseOps(plan, index)[0].op).toBe('move');
  });
});

describe('planToRows', () => {
  it('renders a move as a from and to pair of folder paths', () => {
    const rows = planToRows({ id: 'p1', ops: [{ op: 'move', id: anyBookmark.id, parentId: devFolder.id }] }, index);
    expect(rows[0]).toMatchObject({
      kind: 'move',
      title: anyBookmark.title,
      from: anyBookmark.folderPath,
      to: devFolder.folderPath
    });
  });

  it('resolves a temp parent to the folder title being created', () => {
    const rows = planToRows(
      {
        id: 'p1',
        ops: [
          { op: 'create_folder', tempId: 't1', parentId: devFolder.id, title: 'Rust' },
          { op: 'move', id: anyBookmark.id, parentId: 'temp:t1' }
        ]
      },
      index
    );
    expect(rows.find(r => r.kind === 'move')?.to).toBe(`${devFolder.folderPath}/Rust`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/plan.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `plan.ts`**

`validatePlan` walks ops in order, keeping a `Set` of `tempId`s already created and a resolver that accepts either a real folder id present in `index.folderById` or `temp:<id>` already in that set. It collects every error rather than throwing on the first, so the review UI can show all problems at once.

`inverseOps` maps each op to its inverse using pre-state from `index`, then reverses the array:
- `move` inverts to a `move` back to the recorded `parentId` and `index`
- `update` inverts to an `update` restoring the previous `title` and `url` for exactly the fields the forward op set
- `delete` inverts to a `create_bookmark` op, which requires adding that variant to `Op`: `{ op: 'create_bookmark'; tempId: string; parentId: string; title: string; url: string; index?: number }`
- `create_folder` inverts to a `delete` of the created folder, resolved at apply time from the returned real id

`planToRows` resolves `temp:` parents by looking up the pending `create_folder` op and composing its parent's `folderPath` with its title.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the round trip property test**

```ts
it('applying inverse ops to a plan restores the original parent', () => {
  const plan = { id: 'p1', ops: [{ op: 'move' as const, id: anyBookmark.id, parentId: devFolder.id }] };
  const inverse = inverseOps(plan, index);
  expect(inverse[0]).toMatchObject({ parentId: anyBookmark.parentId, index: anyBookmark.index });
});
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: bookmark reorg plan model with validation and inverse ops"
```

---

### Task 6: Plan generators for duplicates and dead links

**Files:**
- Create: `src/server/generators.ts`
- Test: `tests/generators.test.ts`

**Interfaces:**
- Consumes: `Plan`, `Op`, `BookmarkIndex`
- Produces:
  - `normalizeUrl(url: string): string`
  - `findDuplicates(index: BookmarkIndex): BookmarkNode[][]` clusters of 2 or more
  - `duplicatePlan(index: BookmarkIndex): Plan` keeping the oldest of each cluster
  - `deadLinkPlan(index, check: (url: string) => Promise<boolean>): Promise<Plan>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { normalizeUrl, findDuplicates, duplicatePlan, deadLinkPlan } from '../src/server/generators.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);

describe('normalizeUrl', () => {
  it('ignores a trailing slash', () => {
    expect(normalizeUrl('https://x.com/a/')).toBe(normalizeUrl('https://x.com/a'));
  });
  it('ignores the scheme and a www prefix', () => {
    expect(normalizeUrl('http://www.x.com/a')).toBe(normalizeUrl('https://x.com/a'));
  });
  it('ignores utm parameters but keeps meaningful ones', () => {
    expect(normalizeUrl('https://x.com/a?utm_source=t')).toBe(normalizeUrl('https://x.com/a'));
    expect(normalizeUrl('https://x.com/a?id=1')).not.toBe(normalizeUrl('https://x.com/a'));
  });
  it('ignores the fragment', () => {
    expect(normalizeUrl('https://x.com/a#top')).toBe(normalizeUrl('https://x.com/a'));
  });
});

describe('findDuplicates', () => {
  it('clusters the fixture duplicate pair', () => {
    const clusters = findDuplicates(index);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });
});

describe('duplicatePlan', () => {
  it('deletes all but the oldest of each cluster', () => {
    const plan = duplicatePlan(index);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].op).toBe('delete');
    const cluster = findDuplicates(index)[0];
    const oldest = [...cluster].sort((a, b) => a.dateAdded - b.dateAdded)[0];
    expect((plan.ops[0] as { id: string }).id).not.toBe(oldest.id);
  });
});

describe('deadLinkPlan', () => {
  it('deletes only the urls the checker reports dead', async () => {
    const dead = new Set(['https://dead.example.com/']);
    const plan = await deadLinkPlan(index, async url => !dead.has(url));
    expect(plan.ops.every(op => op.op === 'delete')).toBe(true);
  });
});
```

Adjust the fixture so exactly one duplicate cluster and one `https://dead.example.com/` bookmark exist.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/generators.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`normalizeUrl` parses with `new URL`, lowercases the host, strips a leading `www.`, drops the hash, drops any param whose name starts with `utm_` or equals `fbclid` or `gclid`, sorts the remaining params, and strips a single trailing slash from the pathname. It returns the original string unchanged if `new URL` throws.

`deadLinkPlan` takes the liveness checker as a parameter precisely so tests never hit the network. The tool wiring in Task 9 passes a real checker that issues a `HEAD` with a 5 second timeout and a concurrency cap of 8, treating any 2xx or 3xx as alive and a network error or 404 or 410 as dead.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/generators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: duplicate and dead link plan generators"
```

---

### Task 7: WebSocket bridge

**Files:**
- Create: `src/server/bridge.ts`
- Create: `src/shared/protocol.ts`
- Test: `tests/bridge.test.ts`

**Interfaces:**
- Consumes: `Op` from Task 5
- Produces:
  - `src/shared/protocol.ts`: `type ClientMessage = { type: 'hello'; token: string } | { type: 'result'; id: string; applied: AppliedOp[] } | { type: 'error'; id: string; index: number; message: string } | { type: 'pong' }`, `type ServerMessage = { type: 'welcome' } | { type: 'reject'; reason: string } | { type: 'apply'; id: string; ops: Op[] } | { type: 'ping' }`, `type AppliedOp = { tempId?: string; newId?: string }`
  - `class Bridge { constructor(opts: { port: number; token: string }); start(): Promise<void>; stop(): Promise<void>; isConnected(): boolean; apply(ops: Op[], timeoutMs?: number): Promise<AppliedOp[]> }`
  - `getOrCreateToken(): string` reading or writing `statePath('token')`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Bridge } from '../src/server/bridge.js';

let bridge: Bridge | undefined;
afterEach(async () => { await bridge?.stop(); bridge = undefined; });

const connect = (port: number) => new Promise<WebSocket>(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => resolve(ws));
});

describe('Bridge', () => {
  it('rejects a client with a bad token', async () => {
    bridge = new Bridge({ port: 45711, token: 'good' });
    await bridge.start();
    const ws = await connect(45711);
    const reply = await new Promise<any>(resolve => {
      ws.on('message', raw => resolve(JSON.parse(String(raw))));
      ws.send(JSON.stringify({ type: 'hello', token: 'bad' }));
    });
    expect(reply.type).toBe('reject');
    ws.close();
  });

  it('reports not connected before a client says hello', async () => {
    bridge = new Bridge({ port: 45712, token: 'good' });
    await bridge.start();
    expect(bridge.isConnected()).toBe(false);
  });

  it('round trips an apply to a paired client', async () => {
    bridge = new Bridge({ port: 45713, token: 'good' });
    await bridge.start();
    const ws = await connect(45713);
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'welcome') return;
      if (msg.type === 'apply') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, applied: [{ tempId: 't1', newId: '42' }] }));
      }
    });
    ws.send(JSON.stringify({ type: 'hello', token: 'good' }));
    await new Promise(r => setTimeout(r, 50));
    const applied = await bridge.apply([{ op: 'create_folder', tempId: 't1', parentId: '1', title: 'Rust' }]);
    expect(applied).toEqual([{ tempId: 't1', newId: '42' }]);
    ws.close();
  });

  it('rejects apply with an actionable message when no client is paired', async () => {
    bridge = new Bridge({ port: 45714, token: 'good' });
    await bridge.start();
    await expect(bridge.apply([{ op: 'delete', id: '1' }])).rejects.toThrow(/extension/i);
  });

  it('surfaces a client side op failure with the failing index', async () => {
    bridge = new Bridge({ port: 45715, token: 'good' });
    await bridge.start();
    const ws = await connect(45715);
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'apply') {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, index: 1, message: 'no such node' }));
      }
    });
    ws.send(JSON.stringify({ type: 'hello', token: 'good' }));
    await new Promise(r => setTimeout(r, 50));
    await expect(bridge.apply([{ op: 'delete', id: '1' }])).rejects.toThrow(/index 1/);
    ws.close();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/bridge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `bridge.ts`**

`WebSocketServer` from `ws` bound to `host: '127.0.0.1'`. On connection, wait for `hello`; compare the token with `timingSafeEqual` over equal-length buffers; on mismatch send `{ type: 'reject', reason }` and close. On match, store the socket as the single paired client and send `welcome`. A new successful pairing replaces any existing client.

`apply` generates a request id, sends `{ type: 'apply', id, ops }`, and returns a promise stored in a `Map<string, { resolve, reject, timer }>`. It rejects after `timeoutMs` (default 30000) with a message naming the extension. When no client is paired it rejects immediately with: `Chrome extension is not connected. Open Chrome, confirm the chrome-bookmarks-mcp extension is enabled at chrome://extensions, and check the pairing token in its options page.`

`getOrCreateToken` reads `statePath('token')` or generates 32 hex chars with `randomBytes(16)` and writes it with mode `0o600`.

A 20 second interval sends `{ type: 'ping' }` to the paired client, which keeps the MV3 service worker alive.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/bridge.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: localhost websocket bridge to the chrome extension"
```

---

### Task 8: Companion Chrome extension

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/apply-ops.js`
- Create: `extension/service-worker.js`
- Create: `extension/options.html`, `extension/options.js`
- Test: `tests/apply-ops.test.ts`

**Interfaces:**
- Consumes: `Op`, `AppliedOp` from Tasks 5 and 7
- Produces: `applyOps(ops, chromeBookmarks): Promise<AppliedOp[]>` where `chromeBookmarks` is any object shaped like `chrome.bookmarks` with `create`, `move`, `update`, `remove`, `removeTree`, `get`. Kept free of Chrome globals so Node can test it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
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

  it('applies an update', async () => {
    const api = mockBookmarks();
    await applyOps([{ op: 'update', id: '10', title: 'The Rust Book' }], api);
    expect(api.nodes.get('10').title).toBe('The Rust Book');
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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/apply-ops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `extension/apply-ops.js`**

Plain ESM JavaScript so the extension can import it directly and vitest can too. It walks ops in order, keeps a `Map` from `tempId` to real id, resolves any `parentId` starting with `temp:` through that map, and on failure throws an error carrying `{ index, message }`. Soft deletes (`hard` not set) are handled by the server rewriting them into a move to the `_MCP Trash` folder before they ever reach the extension, so `applyOps` only ever sees a real `delete` for hard deletes.

- [ ] **Step 4: Write the manifest**

```json
{
  "manifest_version": 3,
  "name": "chrome-bookmarks-mcp bridge",
  "version": "0.1.0",
  "description": "Lets the local chrome-bookmarks-mcp server read and reorganize your bookmarks.",
  "permissions": ["bookmarks", "storage"],
  "host_permissions": [],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "options_page": "options.html"
}
```

No `host_permissions` are needed for a WebSocket to `127.0.0.1` from a service worker.

- [ ] **Step 5: Implement the service worker**

Connects to `ws://127.0.0.1:<port>`, sends `hello` with the token from `chrome.storage.local`, replies to `ping` with `pong`, handles `apply` by calling `applyOps(ops, chrome.bookmarks)` and posting back `result` or `error`. Reconnects with exponential backoff capped at 30 seconds. A `chrome.alarms` entry every 30 seconds triggers a reconnect check in case the worker was evicted between pings.

- [ ] **Step 6: Implement the options page**

A token field and a port field persisted to `chrome.storage.local`, plus a live connection status line. Copy contains no em dashes.

- [ ] **Step 7: Run tests and load the extension**

Run: `pnpm vitest run tests/apply-ops.test.ts`
Expected: PASS, 5 tests.

Then load unpacked from `extension/` at `chrome://extensions` with Developer mode on. This is a manual step for Billy.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: mv3 companion extension applying bookmark op batches"
```

---

### Task 9: Write tools, backups, trash, and undo

**Files:**
- Create: `src/server/tools-write.ts`
- Create: `src/server/backup.ts`
- Modify: `src/server/index.ts`
- Test: `tests/backup.test.ts`, `tests/tools-write.test.ts`

**Interfaces:**
- Consumes: `Bridge`, `Plan`, `validatePlan`, `inverseOps`, generators
- Produces:
  - `snapshot(bookmarksPath: string): Promise<string>` returning the backup path
  - `pruneBackups(dir: string, keep: number): Promise<void>`
  - `resolveSoftDeletes(plan: Plan, index: BookmarkIndex): Plan` rewriting non-hard deletes into moves to `_MCP Trash`, prepending a `create_folder` op when that folder does not exist
  - `registerWriteTools(server: McpServer, ctx: WriteCtx): void`
  - `type WriteCtx = { source: BookmarksSource; bridge: Bridge; bookmarksPath: string }`

- [ ] **Step 1: Write the failing test for soft deletes and backups**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBookmarks } from '../src/server/bookmarks-file.js';
import { resolveSoftDeletes } from '../src/server/tools-write.js';
import { snapshot, pruneBackups } from '../src/server/backup.js';

const index = parseBookmarks(
  JSON.parse(readFileSync(new URL('./fixtures/Bookmarks.json', import.meta.url), 'utf8'))
);

describe('resolveSoftDeletes', () => {
  it('rewrites a soft delete into a move to the trash folder', () => {
    const id = index.bookmarks[0].id;
    const out = resolveSoftDeletes({ id: 'p1', ops: [{ op: 'delete', id }] }, index);
    expect(out.ops.some(op => op.op === 'create_folder' && op.title === '_MCP Trash')).toBe(true);
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
});

describe('snapshot', () => {
  it('copies the bookmarks file into the backups dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbm-'));
    const src = join(dir, 'Bookmarks');
    writeFileSync(src, '{"roots":{}}');
    const out = await snapshot(src);
    expect(readFileSync(out, 'utf8')).toBe('{"roots":{}}');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/tools-write.test.ts tests/backup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement backup and soft delete resolution**

`snapshot` copies the bookmarks file to `statePath('backups', `${new Date().toISOString().replaceAll(':', '-')}.json`)` and returns the path. `pruneBackups` keeps the newest N (default 20) and deletes the rest.

- [ ] **Step 4: Implement the write tools**

`apply_plan` is the core. Its sequence:

1. Parse and validate input against the zod schema `z.object({ plan: PlanSchema, dry_run: z.boolean().optional() })`.
2. Load the current index.
3. `validatePlan`. On failure return the errors as text without touching anything.
4. If `dry_run`, return `planToRows` output and stop.
5. `snapshot` the bookmarks file, then `pruneBackups`.
6. `resolveSoftDeletes`.
7. Compute `inverseOps` from the pre-state.
8. `bridge.apply(ops)`.
9. On success write `{ planId, inverse, appliedAt }` to `statePath('last-batch.json')` and return a summary.
10. On failure, replay the inverse ops for the prefix that did apply, then return the failure and the fact that the partial batch was rolled back.

`undo_last_batch` reads `last-batch.json`, applies the recorded inverse ops through the bridge, then deletes the file so undo is not repeatable.

`create_folder`, `move_bookmarks`, `update_bookmark`, and `delete_bookmarks` each build a one-op or few-op `Plan` and delegate to the same internal `applyPlan` function, so there is exactly one write path.

`propose_reorg` takes `z.object({ plan: PlanSchema.optional(), generate: z.enum(['duplicates', 'dead_links']).optional(), note: z.string().optional() })`, produces a plan either from the argument or from a generator, validates it, and returns `structuredContent: { plan, rows, errors }` linked to `ui://bookmarks/review`. It applies nothing.

- [ ] **Step 5: Wire into `index.ts`**

Start the bridge on a port from `CHROME_BOOKMARKS_MCP_PORT` (default 45732), pass `getOrCreateToken()`, and log the token to stderr on first run so it can be pasted into the extension options.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: write tools with backups, soft delete trash, and undo"
```

---

### Task 10: View build pipeline and resource registration

**Files:**
- Create: `views/build.mjs`
- Create: `views/src/host.ts`
- Create: `src/server/views.ts`
- Modify: `src/server/index.ts`, `package.json`
- Test: `tests/views-registration.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces:
  - `views/dist/explorer.html` and `views/dist/review.html`, each a single file with inline CSS and JS
  - `registerViews(server: McpServer): void` registering `ui://bookmarks/explorer` and `ui://bookmarks/review` with mimeType `text/html;profile=mcp-app`
  - `views/src/host.ts` exporting `connectHost()` returning `{ callTool, onToolResult, openLink, notifySize }`

- [ ] **Step 1: Add dependencies**

```bash
pnpm add @modelcontextprotocol/ext-apps
```

- [ ] **Step 2: Write the build script**

`views/build.mjs` runs esbuild with `bundle: true`, `format: 'iife'`, `minify: true`, then inlines the JS and CSS into an HTML shell and writes to `views/dist/<name>.html`. Add `"build:views": "node views/build.mjs"` to scripts and make `build` run it.

The HTML shell contains no external references at all, satisfying the CSP.

- [ ] **Step 3: Write the failing registration test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { UI_RESOURCES } from '../src/server/views.js';

describe('view resources', () => {
  it('declares both views with the exact mcp-app mimetype', () => {
    for (const resource of UI_RESOURCES) {
      expect(resource.uri.startsWith('ui://')).toBe(true);
      expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    }
  });

  it('has a built html file for each declared view', () => {
    for (const resource of UI_RESOURCES) {
      expect(existsSync(resource.file)).toBe(true);
    }
  });

  it('ships self contained html with no external references', () => {
    for (const resource of UI_RESOURCES) {
      const html = readFileSync(resource.file, 'utf8');
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
      expect(html).not.toMatch(/https?:\/\/(?!x\.com)/);
    }
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run tests/views-registration.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implement `views.ts`**

```ts
export const UI_RESOURCES = [
  { uri: 'ui://bookmarks/explorer', name: 'Bookmark explorer', file: /* resolved path to views/dist/explorer.html */ },
  { uri: 'ui://bookmarks/review', name: 'Reorganization review', file: /* views/dist/review.html */ }
].map(r => ({ ...r, mimeType: 'text/html;profile=mcp-app' as const }));

export function registerViews(server: McpServer): void {
  for (const resource of UI_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { mimeType: resource.mimeType },
      async () => ({
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: readFileSync(resource.file, 'utf8') }]
      })
    );
  }
}
```

- [ ] **Step 6: Implement `host.ts`**

Wraps `@modelcontextprotocol/ext-apps` `App` and `PostMessageTransport`. Performs the `ui/initialize` handshake with `protocolVersion: '2026-01-26'`, subscribes to `ui/notifications/tool-input` and `ui/notifications/tool-result`, exposes `callTool(name, args)` over `tools/call`, `openLink(url)` over `ui/open-link`, and wires a `ResizeObserver` on `document.body` posting `ui/notifications/size-changed`.

- [ ] **Step 7: Run tests**

Run: `pnpm build:views && pnpm vitest run tests/views-registration.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: self contained mcp app view build and resource registration"
```

---

### Task 11: Explorer view

**Files:**
- Create: `views/src/explorer.ts`, `views/src/explorer.css`
- Test: `tests/explorer-transform.test.ts`

**Interfaces:**
- Consumes: `connectHost` from Task 10, `structuredContent` from `list_folders` and `search_bookmarks`
- Produces: `flattenTree(tree, expanded: Set<string>): TreeRow[]` and `hostname(url: string): string`, both pure and exported for testing

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { flattenTree, hostname } from '../views/src/explorer.js';

const tree = [
  { id: '1', title: 'Bookmarks bar', folderPath: '/Bookmarks bar', bookmarkCount: 2, totalCount: 5, children: [
    { id: '2', title: 'Dev', folderPath: '/Bookmarks bar/Dev', bookmarkCount: 2, totalCount: 3, children: [
      { id: '3', title: 'Rust', folderPath: '/Bookmarks bar/Dev/Rust', bookmarkCount: 1, totalCount: 1, children: [] }
    ] }
  ] }
];

describe('flattenTree', () => {
  it('hides children of collapsed folders', () => {
    expect(flattenTree(tree, new Set()).map(r => r.title)).toEqual(['Bookmarks bar']);
  });

  it('reveals one level per expanded folder', () => {
    expect(flattenTree(tree, new Set(['1'])).map(r => r.title)).toEqual(['Bookmarks bar', 'Dev']);
  });

  it('tracks depth for indentation', () => {
    const rows = flattenTree(tree, new Set(['1', '2']));
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2]);
  });
});

describe('hostname', () => {
  it('strips the scheme and www', () => {
    expect(hostname('https://www.rust-lang.org/learn')).toBe('rust-lang.org');
  });
  it('returns the raw string for an unparseable url', () => {
    expect(hostname('not a url')).toBe('not a url');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/explorer-transform.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the view**

Two-pane layout. Left: the folder tree from `flattenTree`, each row showing title and `totalCount`, clicking a row calls `list_bookmarks` for that folder through the host. Right: result cards showing title, a generated letter mark (never a remote favicon, the CSP forbids it), `hostname(url)`, and folder path. A filter input calls `search_bookmarks` with a 250ms debounce. Clicking a card calls `openLink`.

Styling uses `useHostStyles` tokens so it matches the Claude theme in light and dark. Every color is defined in a `:root` block and overridden under the host's dark token set, never defined only inside a media query.

- [ ] **Step 4: Run tests and build**

Run: `pnpm vitest run tests/explorer-transform.test.ts && pnpm build:views`
Expected: PASS and both HTML files rebuilt.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: bookmark explorer view"
```

---

### Task 12: Review view

**Files:**
- Create: `views/src/review.ts`, `views/src/review.css`
- Test: `tests/review-transform.test.ts`

**Interfaces:**
- Consumes: `connectHost`, `PlanRow` from Task 5, `apply_plan` tool
- Produces: `groupRows(rows: PlanRow[]): RowGroup[]` and `filterPlan(plan: Plan, rejectedIds: Set<string>): Plan`, both pure

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { groupRows, filterPlan } from '../views/src/review.js';

const rows = [
  { kind: 'move' as const, id: 'a', title: 'A', from: '/bar', to: '/bar/Dev' },
  { kind: 'move' as const, id: 'b', title: 'B', from: '/bar', to: '/bar/Dev' },
  { kind: 'delete' as const, id: 'c', title: 'C', detail: 'duplicate' }
];

describe('groupRows', () => {
  it('groups moves by destination folder', () => {
    const groups = groupRows(rows);
    const dev = groups.find(g => g.label === '/bar/Dev')!;
    expect(dev.rows).toHaveLength(2);
  });

  it('puts deletes in their own group', () => {
    expect(groupRows(rows).some(g => g.label === 'Delete')).toBe(true);
  });
});

describe('filterPlan', () => {
  it('drops ops whose row was rejected', () => {
    const plan = { id: 'p', ops: [{ op: 'move' as const, id: 'a', parentId: '2' }, { op: 'delete' as const, id: 'c' }] };
    expect(filterPlan(plan, new Set(['c'])).ops).toHaveLength(1);
  });

  it('keeps a create_folder op when any move still targets it', () => {
    const plan = {
      id: 'p',
      ops: [
        { op: 'create_folder' as const, tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'move' as const, id: 'a', parentId: 'temp:t1' },
        { op: 'move' as const, id: 'b', parentId: 'temp:t1' }
      ]
    };
    expect(filterPlan(plan, new Set(['b'])).ops).toHaveLength(2);
  });

  it('drops a create_folder op when every move targeting it was rejected', () => {
    const plan = {
      id: 'p',
      ops: [
        { op: 'create_folder' as const, tempId: 't1', parentId: '1', title: 'Dev' },
        { op: 'move' as const, id: 'a', parentId: 'temp:t1' }
      ]
    };
    expect(filterPlan(plan, new Set(['a'])).ops).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/review-transform.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the view**

Header shows the plan note and counts, for example `142 moves, 8 deletes, 6 new folders`. Body is groups from `groupRows`, each with a header carrying a group-level toggle and a count, each row showing the bookmark title, `from -> to` as two folder chips, and a checkbox. Deletes render in a distinct group with the reason in `detail`. Footer has the kept-row count and an Apply button that calls `apply_plan` with `filterPlan(plan, rejected)`.

Apply disables the button, shows progress, and on the tool result renders success with the backup path or the failure with the rollback note. Errors from validation render as a red banner listing every message.

- [ ] **Step 4: Run tests and build**

Run: `pnpm vitest run && pnpm build:views`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: reorganization plan review view with per row approval"
```

---

### Task 13: Install docs and end to end smoke test

**Files:**
- Create: `README.md`
- Create: `scripts/smoke.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the README**

Cover: what it does, the four manual setup steps from the spec, the environment variables (`CHROME_BOOKMARKS_PATH`, `CHROME_BOOKMARKS_MCP_PORT`, `CHROME_BOOKMARKS_MCP_HOME`), the tool list, where backups live, and how to undo. State plainly that writes require the extension and reads do not. No em dashes.

- [ ] **Step 2: Write the smoke script**

`scripts/smoke.mjs` spawns the built server over stdio, calls `list_folders`, then `search_bookmarks` with a query, and prints the top five hits with timings. It exits non-zero if either call errors.

- [ ] **Step 3: Register the server**

```bash
claude mcp add chrome-bookmarks -- node /Users/b/Desktop/code/chrome-bookmarks-mcp/dist/server/index.js
```

- [ ] **Step 4: Run the smoke test**

Run: `pnpm build && node scripts/smoke.mjs`
Expected: folder tree prints, search returns hits, exit code 0.

- [ ] **Step 5: Verify the write path end to end**

With the extension loaded and paired, create a throwaway bookmark in Chrome, then run a `propose_reorg` and `apply_plan` moving only that bookmark, confirm the move in Chrome, then `undo_last_batch` and confirm it returned. Do not run a bulk plan against the real 2,000 bookmarks until this passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: readme and end to end smoke test"
```

---

## Self-Review Notes

**Spec coverage:** parser (T1), fuzzy (T2), semantic and hybrid (T3), read tools (T4), plan model with inverse ops (T5), duplicate and dead link generators (T6), bridge (T7), extension (T8), write tools with backups, trash, and undo (T9), view pipeline (T10), explorer view (T11), review view (T12), install and smoke (T13). Every spec section maps to a task.

**Known deviation from the spec:** the spec lists `find_duplicates` and `find_dead_links` as tools. This plan folds them into `propose_reorg`'s `generate` parameter, since both produce plans and the spec's own view design routes all approval through `ui://bookmarks/review`. One approval surface, as designed.

**Type consistency:** `Op` gains a `create_bookmark` variant in Task 5 for delete inversion. `AppliedOp` is shared between Tasks 7 and 8 through `src/shared/protocol.ts`. `PlanRow` is produced in Task 5 and consumed unchanged in Task 12.
