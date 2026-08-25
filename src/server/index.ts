import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BookmarksSource } from './bookmarks-file.js';
import { FuzzyRanker } from './search/fuzzy.js';
import { SemanticRanker } from './search/semantic.js';
import { HybridRanker } from './search/hybrid.js';
import { statePath } from './paths.js';
import { registerReadTools } from './tools-read.js';
import { registerWriteTools } from './tools-write.js';
import { registerViews } from './views.js';
import { Bridge, getOrCreateToken } from './bridge.js';
import { DEFAULT_PORT } from '../shared/protocol.js';

const port = Number(process.env.CHROME_BOOKMARKS_MCP_PORT) || DEFAULT_PORT;
const token = getOrCreateToken();

const bridge = new Bridge({ port, token });
bridge.start().then(
  () => {
    // stderr, so it never corrupts the stdio protocol stream
    console.error(
      `[chrome-bookmarks-mcp] bridge listening on 127.0.0.1:${port}\n` +
        `[chrome-bookmarks-mcp] pairing token: ${token}\n` +
        `[chrome-bookmarks-mcp] paste that into the extension options page at chrome://extensions`
    );
  },
  err => {
    console.error(
      `[chrome-bookmarks-mcp] bridge could not listen on port ${port}: ${err.message}. ` +
        `Reads still work, writes will fail. Set CHROME_BOOKMARKS_MCP_PORT to use another port.`
    );
  }
);

serveStdio(() => {
  const server = new McpServer({ name: 'chrome-bookmarks', version: '0.1.0' });

  const source = new BookmarksSource();
  const fuzzy = new FuzzyRanker();
  const semantic = new SemanticRanker(statePath('embeddings.json'));
  const hybrid = new HybridRanker(fuzzy, semantic);

  registerViews(server);
  registerReadTools(server, { source, fuzzy, semantic, hybrid });
  registerWriteTools(server, { source, bridge });

  return server;
});
