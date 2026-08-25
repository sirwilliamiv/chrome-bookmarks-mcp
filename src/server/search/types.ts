import type { BookmarkNode } from '../types.js';

export interface ScoredHit {
  bookmark: BookmarkNode;
  score: number;
}

export interface Ranker {
  rank(query: string, pool: BookmarkNode[], limit: number): Promise<ScoredHit[]>;
}
