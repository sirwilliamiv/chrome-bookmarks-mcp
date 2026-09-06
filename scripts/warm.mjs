#!/usr/bin/env node
/**
 * Downloads the embedding model and embeds the whole library up front, so the
 * first semantic search is fast instead of a silent thirty second stall.
 */
import { BookmarksSource } from '../dist/server/bookmarks-file.js';
import { SemanticRanker } from '../dist/server/search/semantic.js';
import { statePath } from '../dist/server/paths.js';

const source = new BookmarksSource();
const index = await source.get();
const ranker = new SemanticRanker(statePath('embeddings.json'));

console.error(`reading ${source.path}`);
console.error(`embedding ${index.bookmarks.length} bookmarks (downloads a 25MB model on first run)`);
const started = Date.now();
await ranker.warm(index.bookmarks);
console.error(`done in ${((Date.now() - started) / 1000).toFixed(1)}s, cache at ${statePath('embeddings.json')}`);
