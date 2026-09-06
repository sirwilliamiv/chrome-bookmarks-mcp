# chrome-bookmarks-mcp

An MCP server that lets Claude search and reorganize your Chrome bookmarks, with an
interactive approval UI rendered inside Claude.

Reads come straight from Chrome's `Bookmarks` JSON file, so search works even with
Chrome closed. Writes go through a companion extension, because Chrome keeps
bookmarks in memory and overwrites any external edit to that file.

Works with Chrome, Chromium, Brave, Edge, and Vivaldi on macOS, Windows, and Linux.

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

Four steps, all one-time. Node 22 or newer and pnpm.

### 1. Build

```bash
git clone https://github.com/sirwilliamiv/chrome-bookmarks-mcp
cd chrome-bookmarks-mcp
pnpm install
pnpm build
```

### 2. Register the server

```bash
pnpm setup
```

That prints the exact `claude mcp add` command and the Claude Desktop JSON for
this machine, with absolute paths already filled in. Copy whichever you use.

Both point at `dist/server/proxy.js`, a featherweight stdio front end. Every client
forwards to one shared daemon, so there is exactly one bookmark index and one
extension connection no matter how many clients are open. The first client to
start brings the daemon up automatically.

Restart the client afterwards. Quit Claude Desktop fully with Command-Q, not just
the window.

### 3. Load the companion extension

Writes need it. Reads do not.

1. Open `chrome://extensions` and turn on Developer mode.
2. Choose "Load unpacked" and pick the `extension/` directory.
3. Open the extension's options page and paste the pairing token, or click
   Paste if it is on your clipboard.

The token is printed when the server starts, and lives at
`~/.chrome-bookmarks-mcp/token`. `pnpm setup` prints the full path.

Ask Claude to run `bridge_status` to confirm the connection.

### 4. Warm the search index (optional)

```bash
pnpm warm
```

The first semantic search downloads a 25MB model and embeds the whole library,
about 25 seconds for 2,000 bookmarks. Running this once up front means the first
search inside Claude is instant. Embeddings are cached by guid and only recomputed
for bookmarks whose title, folder, or url changed.

### 5. Enable MCP Apps rendering (Claude Code only)

Claude web and desktop render server-provided views natively. In Claude Code:

```
/plugin marketplace add modelcontextprotocol/ext-apps
/plugin install mcp-apps@modelcontextprotocol-ext-apps
```

## Other browsers and profiles

The default is Chrome's `Default` profile. Point elsewhere with environment
variables in the MCP server config:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHROME_BOOKMARKS_BROWSER` | `chrome` | `chrome`, `chromium`, `brave`, `edge`, or `vivaldi` |
| `CHROME_PROFILE` | `Default` | Profile directory name, for example `Profile 2` |
| `CHROME_BOOKMARKS_PATH` | derived | Full path to a `Bookmarks` file, overrides both above |

The extension applies writes to whichever browser you load it in, so load it in
the same browser and profile the server reads from.

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

Plans can move, rename, and soft-delete folders as well as bookmarks. New folders
are referenced by later ops in the same plan as `temp:<tempId>`.

## Safety

Bulk edits to two thousand bookmarks are exactly where this could hurt, so:

- Every write path supports `dry_run` and returns the diff first.
- The `Bookmarks` file is copied to `~/.chrome-bookmarks-mcp/backups/` before each
  batch. The newest 20 are kept.
- Deletes move to an `_MCP Trash` folder unless you pass `hard: true`. Folders can
  only be soft deleted.
- Each batch records inverse ops, so `undo_last_batch` genuinely reverses it.
- Plans are validated against the live index before applying. A stale id fails the
  whole batch rather than applying half of it.
- If an op fails mid-batch, the ops that already applied are rolled back.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHROME_BOOKMARKS_BROWSER` | `chrome` | Which Chromium browser to read |
| `CHROME_PROFILE` | `Default` | Which profile to read |
| `CHROME_BOOKMARKS_PATH` | derived from the two above | Explicit path to a `Bookmarks` file |
| `CHROME_BOOKMARKS_MCP_PORT` | `45732` | Bridge port, must match the extension options |
| `CHROME_BOOKMARKS_MCP_HTTP_PORT` | `45731` | Port the shared daemon serves MCP on |
| `CHROME_BOOKMARKS_MCP_HOME` | `~/.chrome-bookmarks-mcp` | Token, embeddings cache, backups, undo record |

## Development

```bash
pnpm test                      # unit tests
pnpm typecheck                 # server and views
pnpm build                     # views then server, restarts a running daemon
pnpm smoke                     # end to end, standalone stdio server
pnpm smoke:shared              # end to end, two clients against one daemon
```

Daemon control, only needed to inspect or recycle it:

```bash
node scripts/daemon.mjs status
node scripts/daemon.mjs restart
node scripts/daemon.mjs logs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the daemon, proxy, and extension
fit together.

## Layout

```
src/server/      MCP server: parser, search, plans, bridge, tools
                 core.ts builds it, daemon.ts is the shared instance,
                 proxy.ts is the per-client stdio front end
src/shared/      Protocol types shared with the extension
extension/       MV3 companion extension, applies op batches via chrome.bookmarks
views/src/       MCP App views, bundled to single self-contained HTML files
scripts/         setup, warm, smoke tests, daemon control
```

Views render under `default-src 'none'` with only `'self'` and `'unsafe-inline'`
allowed, so everything they need is inlined at build time.

## License

MIT
