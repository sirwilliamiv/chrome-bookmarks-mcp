# Contributing

## Setup

```bash
pnpm install
pnpm build          # views, then server; restarts a running daemon
pnpm test           # unit tests
pnpm typecheck      # server and views
pnpm smoke          # end to end against the standalone stdio server
pnpm smoke:shared   # two clients against one daemon
```

Node 22 or newer. The daemon uses `fetch` and `AbortSignal.timeout`, which older
Node versions do not have.

## How the pieces fit

```
  Claude Code        Claude Desktop       any other MCP client
      |                    |                       |
   proxy.js             proxy.js               proxy.js        stdio, one per client
      \____________________|_______________________/
                           |  HTTP, JSON per request
                        daemon.js                               one per machine
                     ______|______
                    |             |
              bookmark index    Bridge                          WebSocket + pairing token
              (reads the        |
               Bookmarks file)  |
                            extension/                          MV3, applies ops via chrome.bookmarks
```

**Reads never touch Chrome.** The daemon parses Chrome's `Bookmarks` JSON file
straight from disk, keyed by mtime, so search works with the browser closed.

**Writes always go through the extension.** Chrome keeps bookmarks in memory and
rewrites the file on its own schedule, so editing the file directly gets clobbered.
The daemon sends a batch of ops over a local WebSocket, the extension replays them
with `chrome.bookmarks.*`, and reports back the ids of anything it created.

**One daemon, many clients.** `proxy.js` is a tiny stdio front end. The first one
to start spawns `daemon.js` if it is not already listening, then every proxy
forwards JSON-RPC over HTTP. That way there is exactly one index, one embedding
cache, and one extension connection no matter how many Claude windows are open.

## Where things live

```
src/server/bookmarks-file.ts   parser, default path per platform and browser
src/server/search/             fuzzy ranker, semantic ranker (MiniLM), hybrid fusion
src/server/plan.ts             op schema, validation, undo inverse, review rows
src/server/tools-write.ts      the single write path: backup, trash, apply, undo record
src/server/bridge.ts           WebSocket server the extension dials into
src/server/daemon.ts           shared instance, HTTP MCP + health endpoint
src/server/proxy.ts            per client stdio front end
src/shared/protocol.ts         types shared with the extension
extension/                     MV3 companion, apply-ops.js is pure and unit tested
views/src/                     MCP App views, bundled to single self-contained HTML files
scripts/                       register, warm, smoke tests, daemon control
```

## Plans

Every write is a `Plan`, an ordered list of ops. New folders get a `tempId` and are
referenced by later ops as `temp:<tempId>`. Validation runs against the live index
before anything is sent, so a stale id rejects the whole batch. `plan.ts` computes
the inverse of each op from the pre-apply state, which is what `undo_last_batch`
replays.

Soft deletes are rewritten into moves to an `_MCP Trash` folder before apply. Hard
deletes are only allowed on bookmarks, never folders.

## Testing writes without Chrome

`extension/apply-ops.js` has no Chrome globals. `tests/apply-ops.test.ts` runs it
against an in-memory fake of `chrome.bookmarks`. `tests/bridge.test.ts` does the same
for the WebSocket side. If you change the op schema, both need updating.

## Style

Conventional commits (`feat:`, `fix:`, `chore:`). Keep comments for the why, not the
what. No AI attribution trailers.
