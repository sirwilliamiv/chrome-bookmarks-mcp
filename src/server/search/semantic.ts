import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BookmarkNode } from '../types.js';
import type { Ranker, ScoredHit } from './types.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 64;

export type EmbeddingCache = Record<string, { hash: string; vec: number[] }>;

export function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** The folder path carries real signal about intent, so it joins the embedded text. */
export function embedTextOf(b: BookmarkNode): string {
  return `${b.title} ${b.folderPath.replaceAll('/', ' ')} ${b.url}`;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
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

type Extractor = (texts: string[]) => Promise<number[][]>;
let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      // The first run downloads ~25MB. Say so, or it looks like a hang.
      const announced = new Set<string>();
      const pipe = await pipeline('feature-extraction', MODEL, {
        progress_callback: (info: { status?: string; file?: string }) => {
          if (info.status === 'initiate' && info.file && !announced.has(info.file)) {
            announced.add(info.file);
            console.error(`[semantic] downloading ${MODEL} ${info.file}`);
          }
          if (info.status === 'ready') console.error(`[semantic] model ready`);
        }
      });
      return async (texts: string[]) => {
        const out = await pipe(texts, { pooling: 'mean', normalize: true });
        return out.tolist() as number[][];
      };
    })().catch(err => {
      // let a later search retry rather than caching the failure forever
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

export class SemanticRanker implements Ranker {
  private ready = false;
  private cache: EmbeddingCache | null = null;

  constructor(private readonly cachePath: string) {}

  isReady(): boolean {
    return this.ready;
  }

  /** Embeds anything new or changed. Safe to call on every search. */
  async warm(pool: BookmarkNode[]): Promise<void> {
    if (this.cache === null) this.cache = await loadCache(this.cachePath);
    const cache = this.cache;

    const stale = pool.filter(b => {
      const entry = cache[b.guid];
      return !entry || entry.hash !== textHash(embedTextOf(b));
    });

    if (stale.length) {
      const extract = await getExtractor();
      for (let i = 0; i < stale.length; i += BATCH_SIZE) {
        const batch = stale.slice(i, i + BATCH_SIZE);
        const vecs = await extract(batch.map(embedTextOf));
        batch.forEach((b, j) => {
          cache[b.guid] = { hash: textHash(embedTextOf(b)), vec: vecs[j] };
        });
      }
      await saveCache(this.cachePath, cache);
    }
    this.ready = true;
  }

  async rank(query: string, pool: BookmarkNode[], limit: number): Promise<ScoredHit[]> {
    await this.warm(pool);
    const cache = this.cache ?? {};
    const extract = await getExtractor();
    const [qv] = await extract([query]);

    const hits: ScoredHit[] = [];
    for (const bookmark of pool) {
      const entry = cache[bookmark.guid];
      if (!entry) continue;
      hits.push({ bookmark, score: cosine(qv, entry.vec) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
