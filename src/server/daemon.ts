import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Bridge, getOrCreateToken } from './bridge.js';
import { createBookmarksServer, createDeps } from './core.js';
import { statePath } from './paths.js';
import { DEFAULT_HTTP_PORT, DEFAULT_PORT, MCP_PATH } from '../shared/protocol.js';

/**
 * The single shared instance. Owns the one connection to the Chrome extension
 * and the one in-memory bookmark index, and serves MCP over HTTP so every
 * client (Claude Code, Claude Desktop, anything else) talks to the same
 * process instead of spawning its own.
 */

const httpPort = Number(process.env.CHROME_BOOKMARKS_MCP_HTTP_PORT) || DEFAULT_HTTP_PORT;
const bridgePort = Number(process.env.CHROME_BOOKMARKS_MCP_PORT) || DEFAULT_PORT;
const token = getOrCreateToken();

const bridge = new Bridge({ port: bridgePort, token });
const deps = createDeps(bridge);

const handler = createMcpHandler(() => createBookmarksServer(deps), {
  // a single JSON body per request keeps the stdio proxy a dozen lines
  responseMode: 'json',
  onerror: err => console.error(`[daemon] ${err.message}`)
});

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toFetchRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body.length) {
    init.body = new Uint8Array(body);
  }
  return new Request(`http://127.0.0.1:${httpPort}${req.url ?? '/'}`, init);
}

async function writeFetchResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

const http = createServer((req, res) => {
  void (async () => {
    try {
      if (req.url?.startsWith('/healthz')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            pid: process.pid,
            bridgePort,
            extensionConnected: bridge.isConnected()
          })
        );
        return;
      }

      if (!req.url?.startsWith(MCP_PATH)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      const body = await readBody(req);
      const response = await handler.fetch(toFetchRequest(req, body));
      await writeFetchResponse(response, res);
    } catch (err) {
      console.error(`[daemon] request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  })();
});

const pidFile = statePath('daemon.pid');

async function shutdown(signal: string): Promise<void> {
  console.error(`[daemon] ${signal}, shutting down`);
  try {
    unlinkSync(pidFile);
  } catch {
    // already gone
  }
  await handler.close().catch(() => {});
  await bridge.stop().catch(() => {});
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await bridge.start().catch(err => {
  console.error(
    `[daemon] bridge could not listen on ${bridgePort}: ${err.message}. Reads work, writes will fail.`
  );
});

http.listen(httpPort, '127.0.0.1', () => {
  writeFileSync(pidFile, String(process.pid));
  console.error(
    `[daemon] mcp on http://127.0.0.1:${httpPort}${MCP_PATH}\n` +
      `[daemon] bridge on 127.0.0.1:${bridgePort}\n` +
      `[daemon] pairing token: ${token}`
  );
});

http.on('error', err => {
  console.error(`[daemon] http server error: ${err.message}`);
  process.exit(1);
});
