import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Bridge, getOrCreateToken } from './bridge.js';
import { createBookmarksServer, createDeps } from './core.js';
import { DEFAULT_PORT } from '../shared/protocol.js';

/**
 * Standalone stdio server: one process per client, owning its own bridge.
 * Fine when only one MCP client is running. When Claude Code and Claude
 * Desktop are both open, use proxy.js instead so they share one daemon and one
 * extension connection.
 */

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
        `Another instance probably owns it. Reads still work, writes will fail. ` +
        `Point this client at dist/server/proxy.js to share the running instance instead.`
    );
  }
);

const deps = createDeps(bridge);
serveStdio(() => createBookmarksServer(deps));
