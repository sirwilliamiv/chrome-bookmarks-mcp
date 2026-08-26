# chrome-bookmarks-mcp

An MCP server that lets Claude search and reorganize your Chrome bookmarks, with an
interactive approval UI rendered inside Claude.

Reads come straight from Chrome's `Bookmarks` JSON file, so search works even with
Chrome closed. Writes go through a companion extension, because Chrome keeps
bookmarks in memory and overwrites any external edit to that file.

## What it does

- **Hybrid search.** A text scorer over title, url, and folder path, blended by
  reciprocal rank fusion with semantic similarity from a local MiniLM model. No API
  key, nothing leaves the machine. Finds "the thing about rate limiting" when no
  title contains those words.
- **Bulk reorganization.** Claude proposes a plan, you review it as a readable diff
  with per-row checkboxes, and only the rows you keep get applied.
- **Duplicate and dead link cleanup**, folded into the same review flow.
- **Real undo.** Every batch records its inverse ops.

## Setup

Four steps, all one-time.

### 1. Build

```bash
pnpm install
pnpm build
```

### 2. Register the server

Both Claude Code and Claude Desktop point at `proxy.js`, a featherweight stdio
front end. Every client forwards to one shared daemon, so there is exactly one
bookmark index and one Chrome extension connection no matter how many clients
are open. The first client to start brings the daemon up automatically.

Claude Code:

```bash
claude mcp add -s user chrome-bookmarks -- \
  /Users/b/.nvm/versions/node/v22.22.0/bin/node \
  /Users/b/Desktop/code/chrome-bookmarks-mcp/dist/server/proxy.js
```

Claude Desktop, in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome-bookmarks": {
      "command": "/Users/b/.nvm/versions/node/v22.22.0/bin/node",
      "args": ["/Users/b/Desktop/code/chrome-bookmarks-mcp/dist/server/proxy.js"]
    }
  }
}
```

Use the absolute node path. Claude Desktop does not inherit your shell PATH, so
a bare `node` will not resolve.

Then restart the client. Quit Claude Desktop fully with Command-Q, not just the
window.

`dist/server/index.js` is still there as a standalone stdio server that owns its
own bridge. It is fine when only one client will ever run, but two copies of it
fight over the bridge port. Prefer the proxy.

### 3. Load the companion extension

Writes need it. Reads do not.

1. Open `chrome://extensions` and turn on Developer mode.
2. Choose "Load unpacked" and pick the `extension/` directory.
3. Open the extension's options page.
4. Paste the pairing token, then save.

The token is printed to stderr when the server starts, and also lives at
`~/.chrome-bookmarks-mcp/token`.

Ask Claude to run `bridge_status` to confirm the connection.

### 4. Enable MCP Apps rendering (Claude Code only)

Claude web and desktop render server-provided views natively. In Claude Code:

```
/plugin marketplace add modelcontextprotocol/ext-apps
/plugin install mcp-apps@modelcontextprotocol-ext-apps
```

## Tools

Reads, no extension required:

| Tool | Purpose |
| --- | --- |
| `list_folders` | Folder tree with per-folder counts |
| `list_bookmarks` | Bookmarks directly inside one folder |
| `get_bookmark` | One bookmark by id or guid |
| `search_bookmarks` | Hybrid search. `mode` is `auto`, `fuzzy`, or `semantic` |

Planning, applies nothing:

| Tool | Purpose |
| --- | --- |
| `propose_reorg` | Validate a plan and return it for review. `generate` accepts `duplicates` or `dead_links` |

Writes, extension required:

| Tool | Purpose |
| --- | --- |
| `apply_plan` | Apply a batch. Supports `dry_run` |
| `create_folder`, `move_bookmarks`, `update_bookmark`, `delete_bookmarks` | Single-purpose ops, all routed through the same write path |
| `undo_last_batch` | Reverse the most recent applied batch |
| `bridge_status` | Whether the extension is connected |

## Safety

Bulk edits to two thousand bookmarks are exactly where this could hurt, so:

- Every write path supports `dry_run` and returns the diff first.
- The `Bookmarks` file is copied to `~/.chrome-bookmarks-mcp/backups/` before each
  batch. The newest 20 are kept.
- Deletes move to an `_MCP Trash` folder unless you pass `hard: true`.
- Each batch records inverse ops, so `undo_last_batch` genuinely reverses it.
- Plans are validated against the live index before applying. A stale id fails the
  whole batch rather than applying half of it.
- If an op fails mid-batch, the ops that already applied are rolled back.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHROME_BOOKMARKS_PATH` | `~/Library/Application Support/Google/Chrome/Default/Bookmarks` | Which profile to read |
| `CHROME_BOOKMARKS_MCP_PORT` | `45732` | Bridge port, must match the extension options |
| `CHROME_BOOKMARKS_MCP_HTTP_PORT` | `45731` | Port the shared daemon serves MCP on |
| `CHROME_BOOKMARKS_MCP_HOME` | `~/.chrome-bookmarks-mcp` | Token, embeddings cache, backups, undo record |

## Development

```bash
pnpm test                      # unit tests
pnpm typecheck                 # server and views
pnpm build                     # views then server
node scripts/smoke.mjs         # end to end, standalone stdio server
node scripts/smoke-shared.mjs  # end to end, two clients against one daemon
```

Daemon control, only needed to inspect or recycle it:

```bash
node scripts/daemon.mjs status
node scripts/daemon.mjs restart
node scripts/daemon.mjs logs
```

The first semantic search downloads a 25MB model and embeds the whole library,
which takes about 25 seconds for 2,000 bookmarks. Embeddings are cached by guid and
only recomputed for bookmarks whose title, folder, or url changed, so later searches
are a few milliseconds.

## Layout

```
src/server/      MCP server: parser, search, plans, bridge, tools
                 core.ts builds it, daemon.ts is the shared instance,
                 proxy.ts is the per-client stdio front end
src/shared/      Protocol types shared with the extension
extension/       MV3 companion extension, applies op batches via chrome.bookmarks
views/src/       MCP App views, bundled to single self-contained HTML files
```

Views render under `default-src 'none'` with only `'self'` and `'unsafe-inline'`
allowed for script and style, so the build inlines everything into one file. No
external scripts, fonts, or favicons are possible, which is why site marks are
generated letters rather than fetched icons.
