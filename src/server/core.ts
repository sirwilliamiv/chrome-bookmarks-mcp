import { McpServer } from '@modelcontextprotocol/server';
import { BookmarksSource } from './bookmarks-file.js';
import { FuzzyRanker } from './search/fuzzy.js';
import { SemanticRanker } from './search/semantic.js';
import { HybridRanker } from './search/hybrid.js';
import { statePath } from './paths.js';
import { registerReadTools } from './tools-read.js';
import { registerWriteTools } from './tools-write.js';
import { registerViews } from './views.js';
import type { Bridge } from './bridge.js';

export interface ServerDeps {
  source: BookmarksSource;
  fuzzy: FuzzyRanker;
  semantic: SemanticRanker;
  hybrid: HybridRanker;
  bridge: Bridge;
}

/**
 * Everything expensive lives in the deps, not in the McpServer, so the HTTP
 * daemon can build a throwaway server per request while still sharing one
 * bookmark index, one embedding cache, and one extension connection.
 */
export function createDeps(bridge: Bridge): ServerDeps {
  const source = new BookmarksSource();
  const fuzzy = new FuzzyRanker();
  const semantic = new SemanticRanker(statePath('embeddings.json'));
  const hybrid = new HybridRanker(fuzzy, semantic);
  return { source, fuzzy, semantic, hybrid, bridge };
}

export function createBookmarksServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'chrome-bookmarks', version: '0.1.0' });

  registerViews(server);
  registerReadTools(server, {
    source: deps.source,
    fuzzy: deps.fuzzy,
    semantic: deps.semantic,
    hybrid: deps.hybrid
  });
  registerWriteTools(server, { source: deps.source, bridge: deps.bridge });

  return server;
}
