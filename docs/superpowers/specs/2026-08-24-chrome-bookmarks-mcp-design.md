# chrome-bookmarks-mcp Design

Date: 2026-08-24
Status: approved

## Purpose

Give Claude read and write access to Chrome bookmarks, so it can search them
intelligently and reorganize them in bulk, with a visual approval step rendered
inside Claude via the MCP Apps extension.

Target corpus: ~2,000 bookmarks in the single `Default` Chrome profile on macOS.

## Constraints

1. Chrome holds bookmarks in memory and rewrites
   `~/Library/Application Support/Google/Chrome/Default/Bookmarks` on exit. The
   file also carries a checksum. External writes to it are clobbered or trigger
   a bookmark reset. Therefore writes MUST go through the `chrome.bookmarks`
   extension API.
2. Reads have no such problem. Parsing the JSON file is fast, needs no
   extension, and works with Chrome closed.
3. MCP App views render in a sandboxed iframe under a restrictive default CSP:
   `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'`.
   Views MUST be self-contained HTML with inline CSS and JS. No external
   fetches, no remote fonts, no remote favicons.

## Architecture

Three deliverables in one repo.

### 1. MCP server (`src/server/`)

TypeScript, `@modelcontextprotocol/sdk`, stdio transport.

- `bookmarks-file.ts` — locates the profile, parses the Chrome `Bookmarks`
  JSON into a flat index of `{ id, guid, title, url, folderPath, parentId,
  index, dateAdded }`. Watches mtime and reloads on change.
- `search/` — hybrid ranking behind a `Ranker` interface.
  - `fuzzy.ts` — scored match over title, URL, and folder path.
  - `semantic.ts` — transformers.js with `all-MiniLM-L6-v2`, run locally. No
    API key. Embeddings cached to `~/.chrome-bookmarks-mcp/embeddings.json`,
    keyed by guid plus a hash of the title, recomputed only for changed rows.
  - `hybrid.ts` — blends both by weighted reciprocal rank fusion.
- `bridge.ts` — WebSocket server bound to `127.0.0.1`. Accepts one extension
  client. Verifies a pairing token and the `chrome-extension://` origin.
  Exposes a request/response RPC for batches of bookmark operations.
- `plan.ts` — builds and validates reorganization plans, computes inverse ops,
  and persists the last applied batch for undo.
- `tools.ts` — MCP tool registration.
- `views.ts` — registers `ui://` resources and links them to tools.

### 2. Companion extension (`extension/`)

MV3, permission `bookmarks` only.

- Service worker holds the WebSocket to the server, pings every 20s so MV3
  does not evict it.
- `apply-ops.ts` — pure module mapping op objects to `chrome.bookmarks` calls.
  Kept free of Chrome globals so it is testable in Node against a mock.
- Options page: paste the pairing token once, shows connection status.

Install is manual and one-time: load unpacked at `chrome://extensions` with
Developer mode on.

### 3. MCP App views (`views/`)

Built with `@modelcontextprotocol/ext-apps` and its React bindings, bundled to
single self-contained HTML files (inline CSS and JS) to satisfy the CSP.
Resources use mimeType `text/html;profile=mcp-app` and are linked from tools
via `_meta.ui.resourceUri`. Protocol version `2026-01-26`.

- `ui://bookmarks/explorer` — attached to `search_bookmarks` and
  `list_folders`. Folder tree with counts on the left, result cards on the
  right, live filter box. Selecting a folder re-calls the tool through the
  host via `tools/call`. External links open through `ui/open-link`.
- `ui://bookmarks/review` — attached to `propose_reorg`. Renders a plan as a
  readable diff: each bookmark as `current folder -> proposed folder`, grouped
  by target folder, with per-row and per-group accept/reject toggles. Duplicate
  clusters and dead links appear as delete rows in the same list. One Apply
  button calls `apply_plan` with only the kept rows.

Both views use `useHostStyles` to match the host theme and post
`ui/notifications/size-changed` from a `ResizeObserver`. Favicons are rendered
as generated letter marks, never remote images, because of the CSP.

## Tools

Read (no extension required):

- `list_folders` — folder tree with per-folder counts.
- `list_bookmarks` — contents of a folder, paginated.
- `get_bookmark` — by id or guid.
- `search_bookmarks` — `query`, `mode` (`auto` | `fuzzy` | `semantic`),
  `folder`, `limit`.

Planning (no extension required, produces a plan, applies nothing):

- `propose_reorg` — takes a plan built by Claude, or a generator hint such as
  `duplicates` or `dead_links`, validates it against the current index, and
  returns it for review.

Write (requires the extension):

- `apply_plan` — applies a batch of ops. Supports `dry_run`.
- `create_folder`, `move_bookmarks`, `update_bookmark`, `delete_bookmarks` —
  direct single-purpose ops, all expressed as plans internally.
- `undo_last_batch` — replays recorded inverse ops.

## Safety

Bulk reorganization of 2,000 bookmarks is where this can hurt, so:

- Every write path supports `dry_run` and returns the diff.
- The server snapshots the `Bookmarks` file to
  `~/.chrome-bookmarks-mcp/backups/<timestamp>.json` before each batch.
- Deletes move the bookmark to an `_MCP Trash` folder unless `hard: true`.
- Each batch records inverse ops (prior `parentId` and `index` for moves,
  full node data for deletes) so `undo_last_batch` is real.
- Plans are validated against the live index before applying. A stale id
  fails the whole batch rather than applying partially.

## Error handling

- Extension not connected: write tools fail with an actionable message naming
  the fix (open Chrome, check the extension, re-pair). Read tools are
  unaffected and keep working.
- Bookmarks file missing or unparseable: read tools fail with the resolved
  path that was tried.
- Semantic model not yet downloaded: `search_bookmarks` falls back to fuzzy
  and says so in the result, rather than blocking on a 25MB download.
- Partial batch failure: the bridge applies ops in order and returns the index
  of the first failure. The server then replays inverse ops for everything
  already applied, so a failed batch leaves no half-state.

## Testing

- Parser and ranker: unit tests against a checked-in fixture `Bookmarks` JSON
  with nested folders, duplicate URLs, and unicode titles.
- Plan and inverse-op logic: unit tests, including that applying a plan then
  its inverse returns the index to its starting state.
- `apply-ops`: tested in Node against a mock `chrome.bookmarks` implementing
  the subset used.
- Bridge: tested against a fake WebSocket client speaking the same contract.
- Views: the plan-to-rows transform is a pure function and is unit tested.
  Rendering is verified manually in Claude.

## Out of scope

- Multiple Chrome profiles. Only `Default` exists on this machine. The profile
  path is a config value, so adding profiles later is not a redesign.
- Other browsers.
- Bookmark content fetching or full-text indexing of linked pages. Title, URL,
  and folder path are the corpus.
- Sync to or from anything.

## Manual setup steps

1. Load the unpacked extension at `chrome://extensions`, Developer mode on.
2. Paste the pairing token into the extension options page.
3. Register the server with `claude mcp add`.
4. For Claude Code specifically, install the MCP Apps plugin so views render:
   `/plugin marketplace add modelcontextprotocol/ext-apps` then
   `/plugin install mcp-apps@modelcontextprotocol-ext-apps`. Claude web and
   desktop render views natively.
