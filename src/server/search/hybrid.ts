import type { BookmarkNode } from '../types.js';
import type { Ranker, ScoredHit } from './types.js';
import type { SemanticRanker } from './semantic.js';

/**
 * Reciprocal rank fusion. Rank position matters, raw scores do not, which is
 * what makes it safe to blend a 0-110 fuzzy score with a 0-1 cosine score.
 */
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

export interface HybridResult {
  hits: ScoredHit[];
  degraded: boolean;
  note?: string;
}

export class HybridRanker {
  constructor(
    private readonly fuzzy: Ranker,
    private readonly semantic: SemanticRanker
  ) {}

  async search(query: string, pool: BookmarkNode[], limit: number): Promise<HybridResult> {
    const fuzzyHits = await this.fuzzy.rank(query, pool, limit * 3);
    try {
      const semanticHits = await this.semantic.rank(query, pool, limit * 3);
      return {
        hits: fuseRRF([fuzzyHits, semanticHits], [1, 1]).slice(0, limit),
        degraded: false
      };
    } catch (err) {
      return {
        hits: fuzzyHits.slice(0, limit),
        degraded: true,
        note: `Semantic search unavailable, fuzzy only. ${(err as Error).message}`
      };
    }
  }
}
