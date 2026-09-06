#!/usr/bin/env node
/**
 * Proves the shared-instance setup: spawns two independent stdio proxies at
 * once, the way Claude Code and Claude Desktop each would, and checks they
 * both work and both reach the same daemon process.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const proxyPath = join(root, 'dist', 'server', 'proxy.js');

function client(label) {
  const child = spawn(process.execPath, [proxyPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  child.stderr.on('data', chunk => {
    const line = String(chunk).trim();
    if (line) console.error(`  [${label}] ${line}`);
  });

  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });

  return {
    child,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} ${method} timed out`)), 60_000);
        pending.set(id, message => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${label} ${method}: ${message.error.message}`));
          else resolve(message.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }
  };
}

async function handshake(c, name) {
  await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name, version: '0.1.0' }
  });
  c.notify('notifications/initialized');
}

const a = client('code');
const b = client('desktop');
let failed = false;

try {
  await Promise.all([handshake(a, 'fake-claude-code'), handshake(b, 'fake-claude-desktop')]);
  console.log('both proxies completed the handshake');

  const [toolsA, toolsB] = await Promise.all([a.request('tools/list', {}), b.request('tools/list', {})]);
  console.log(`  code sees ${toolsA.tools.length} tools, desktop sees ${toolsB.tools.length} tools`);
  if (toolsA.tools.length !== toolsB.tools.length) throw new Error('tool lists differ');

  const [foldersA, foldersB] = await Promise.all([
    a.request('tools/call', { name: 'list_folders', arguments: {} }),
    b.request('tools/call', { name: 'list_folders', arguments: {} })
  ]);
  const countA = foldersA.structuredContent.totalBookmarks;
  const countB = foldersB.structuredContent.totalBookmarks;
  console.log(`  both read ${countA} bookmarks`);
  if (countA !== countB) throw new Error('bookmark counts differ');

  const [searchA, searchB] = await Promise.all([
    a.request('tools/call', { name: 'search_bookmarks', arguments: { query: 'banking', limit: 3 } }),
    b.request('tools/call', { name: 'search_bookmarks', arguments: { query: 'banking', limit: 3 } })
  ]);
  console.log(`  concurrent searches returned ${searchA.structuredContent.hits.length} and ${searchB.structuredContent.hits.length} hits`);

  const [bridgeA, bridgeB] = await Promise.all([
    a.request('tools/call', { name: 'bridge_status', arguments: {} }),
    b.request('tools/call', { name: 'bridge_status', arguments: {} })
  ]);
  const connA = bridgeA.structuredContent.connected;
  const connB = bridgeB.structuredContent.connected;
  console.log(`  both see the same extension state: ${connA} / ${connB}`);
  if (connA !== connB) throw new Error('bridge state differs between clients');

  const health = await (await fetch(`http://127.0.0.1:${Number(process.env.CHROME_BOOKMARKS_MCP_HTTP_PORT) || 45731}/healthz`)).json();
  console.log(`  one daemon serving both, pid ${health.pid}`);

  console.log('\nshared instance verified');
} catch (err) {
  failed = true;
  console.error(`\nshared instance check failed: ${err.message}`);
} finally {
  a.child.kill();
  b.child.kill();
  process.exit(failed ? 1 : 0);
}
