import type { BookmarkIndex, BookmarkNode } from './types.js';
import type { Op, Plan } from './plan.js';

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref_src$|igshid$)/;

/**
 * Collapses the cosmetic differences that make the same page look like two
 * bookmarks: scheme, www, trailing slash, fragment, tracking params, and
 * query order.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');

  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return `${host}${path}${params ? `?${params}` : ''}`;
}

export function findDuplicates(index: BookmarkIndex): BookmarkNode[][] {
  const byUrl = new Map<string, BookmarkNode[]>();
  for (const bookmark of index.bookmarks) {
    if (!bookmark.url) continue;
    const key = normalizeUrl(bookmark.url);
    const bucket = byUrl.get(key) ?? [];
    bucket.push(bookmark);
    byUrl.set(key, bucket);
  }
  return [...byUrl.values()].filter(cluster => cluster.length >= 2);
}

/** Keeps the oldest bookmark in each cluster, deletes the rest. */
export function duplicatePlan(index: BookmarkIndex): Plan {
  const clusters = findDuplicates(index);
  const ops: Op[] = [];

  for (const cluster of clusters) {
    const [, ...rest] = [...cluster].sort((a, b) => a.dateAdded - b.dateAdded || a.id.localeCompare(b.id));
    for (const bookmark of rest) ops.push({ op: 'delete', id: bookmark.id });
  }

  return {
    id: `duplicates-${index.loadedAt}`,
    ops,
    note: `${ops.length} duplicate bookmarks across ${clusters.length} clusters. The oldest copy of each is kept.`
  };
}

export type LivenessCheck = (url: string) => Promise<boolean>;

export async function deadLinkPlan(index: BookmarkIndex, isAlive: LivenessCheck): Promise<Plan> {
  const urls = [...new Set(index.bookmarks.map(b => b.url).filter(Boolean))];
  const dead = new Set<string>();

  for (const url of urls) {
    if (!(await isAlive(url))) dead.add(url);
  }

  const ops: Op[] = index.bookmarks
    .filter(b => dead.has(b.url))
    .map(b => ({ op: 'delete' as const, id: b.id }));

  return {
    id: `dead-links-${index.loadedAt}`,
    ops,
    note: `${ops.length} bookmarks point at urls that did not respond.`
  };
}

/**
 * Real liveness checker used by the tool wiring. Treats 2xx and 3xx as alive,
 * and a network error, 404, or 410 as dead. Anything else counts as alive so a
 * bot-blocking site is never mistaken for a dead link.
 */
export function httpLivenessCheck(timeoutMs = 5000): LivenessCheck {
  return async (url: string) => {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      return !(response.status === 404 || response.status === 410);
    } catch {
      return false;
    }
  };
}

/** Runs a liveness check over many urls with a bounded number in flight. */
export function withConcurrency(check: LivenessCheck, limit = 8): LivenessCheck {
  let active = 0;
  const queue: Array<() => void> = [];

  return async (url: string) => {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try {
      return await check(url);
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
