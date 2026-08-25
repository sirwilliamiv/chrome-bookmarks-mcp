import type { BookmarkNode } from '../types.js';
import type { Ranker, ScoredHit } from './types.js';

/**
 * Tiered match score. Title beats url beats folder path, and within a tier a
 * shorter title wins so "Rust" outranks "Rust, Go and Zig compared".
 */
export function scoreOne(query: string, b: BookmarkNode): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const title = b.title.toLowerCase();
  const url = b.url.toLowerCase();
  const folder = b.folderPath.toLowerCase();

  let score: number;
  if (title === q) score = 100;
  else if (title.startsWith(q)) score = 80;
  else if (title.includes(q)) score = 60;
  else if (url.includes(q)) score = 40;
  else if (folder.includes(q)) score = 20;
  else return 0;

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
