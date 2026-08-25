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
  const hybrid = new HybridRanker(fuzzy, semantic);

  registerReadTools(server, { source, fuzzy, semantic, hybrid });

  return server;
});
