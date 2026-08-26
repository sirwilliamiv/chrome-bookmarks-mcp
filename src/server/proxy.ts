import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HTTP_PORT, MCP_PATH } from '../shared/protocol.js';

/**
 * A featherweight stdio front end for the shared daemon. Every MCP client
 * spawns one of these; they all forward to the same daemon process, so there
 * is exactly one bookmark index and one Chrome extension connection no matter
 * how many clients are open.
 *
 * If the daemon is not running, the first proxy to notice starts it.
 */

const httpPort = Number(process.env.CHROME_BOOKMARKS_MCP_HTTP_PORT) || DEFAULT_HTTP_PORT;
const base = `http://127.0.0.1:${httpPort}`;
const here = dirname(fileURLToPath(import.meta.url));
const daemonPath = join(here, 'daemon.js');

const log = (message: string) => console.error(`[proxy] ${message}`);

async function daemonAlive(): Promise<boolean> {
  try {
    const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await daemonAlive()) return;

  if (!existsSync(daemonPath)) {
    throw new Error(`daemon not built at ${daemonPath}. Run pnpm build.`);
  }

  log('daemon not running, starting it');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  });
  child.unref();

  // the loser of a startup race just waits for the winner's daemon
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await daemonAlive()) {
      log('daemon is up');
      return;
    }
  }
  throw new Error('daemon did not become healthy within 5 seconds');
}

function send(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errorFor(id: unknown, message: string): void {
  if (id === undefined || id === null) return;
  send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }));
}

/**
 * An SSE body carries one JSON-RPC message per `data:` field. The daemon picks
 * JSON or SSE depending on which protocol era the client speaks, so relay
 * whichever arrives rather than assuming.
 */
function relaySse(text: string): void {
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const payload = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');
    if (payload) send(payload);
  }
}

async function forward(message: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(`${base}${MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(message)
    });

    // notifications get a bodyless 202, which has nothing to relay
    if (response.status === 202) return;

    const text = (await response.text()).trim();
    if (!text) return;

    if (response.headers.get('content-type')?.includes('text/event-stream')) relaySse(text);
    else send(text);
  } catch (err) {
    const detail = (err as Error).message;
    log(`forward failed: ${detail}`);
    errorFor(message.id, `chrome-bookmarks daemon unreachable: ${detail}`);
  }
}

async function main(): Promise<void> {
  await ensureDaemon();

  let buffer = '';
  // serialize forwarding so responses leave in the order the client sent them
  let chain: Promise<void> = Promise.resolve();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log('dropped a line that was not json');
        continue;
      }
      chain = chain.then(() => forward(message));
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

main().catch(err => {
  log(err.message);
  process.exit(1);
});
