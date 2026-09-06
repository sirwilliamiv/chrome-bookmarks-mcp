#!/usr/bin/env node
/**
 * Prints the client registration commands for this machine, with absolute
 * paths resolved, so nothing has to be hand-edited after cloning.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const proxy = join(root, 'dist', 'server', 'proxy.js');
const extension = join(root, 'extension');
const node = process.execPath;
const stateHome = process.env.CHROME_BOOKMARKS_MCP_HOME ?? join(homedir(), '.chrome-bookmarks-mcp');

const desktopConfig = {
  darwin: join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json'),
  win32: join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Claude/claude_desktop_config.json'),
  linux: join(homedir(), '.config/Claude/claude_desktop_config.json')
}[process.platform] ?? '<claude desktop config path>';

if (!existsSync(proxy)) {
  console.error(`dist/ is missing. Run "pnpm build" first, then "pnpm setup" again.\n`);
}

const q = s => JSON.stringify(s);

console.log(`Claude Code (run this once):

  claude mcp add -s user chrome-bookmarks -- ${q(node)} ${q(proxy)}

Claude Desktop (${desktopConfig}):

${JSON.stringify({ mcpServers: { 'chrome-bookmarks': { command: node, args: [proxy] } } }, null, 2)}

Then restart the client. Reads work immediately.

For writes, load the companion extension:

  1. Open chrome://extensions and turn on Developer mode.
  2. Load unpacked, pick:  ${extension}
  3. Open the extension's options page and paste the pairing token.
     The token is printed when the server starts and stored at:
     ${join(stateHome, 'token')}

Ask Claude to run bridge_status to confirm.`);
