#!/usr/bin/env node
/**
 * End to end smoke test. Spawns the built server over stdio and speaks raw
 * JSON-RPC at it, so it exercises the real wire protocol rather than a mock.
 *
 * Exits non-zero if any call fails.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(root, 'dist', 'server', 'index.js');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CHROME_BOOKMARKS_MCP_PORT: '45799' }
});

child.stderr.on('data', chunk => {
  const line = String(chunk).trim();
  if (line) console.error(`  [server] ${line.split('\n')[0]}`);
});

let buffer = '';
let nextId = 1;
const pending = new Map();

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

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120_000);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function timed(label, fn) {
  const started = Date.now();
  return fn().then(result => {
    console.log(`  ${label} ok in ${Date.now() - started}ms`);
    return result;
  });
}

let failed = false;

try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.1.0' }
  });
  notify('notifications/initialized');
  console.log('handshake ok');

  const tools = await request('tools/list', {});
  console.log(`tools: ${tools.tools.map(t => t.name).join(', ')}`);

  const resources = await request('resources/list', {});
  console.log(`resources: ${resources.resources.map(r => `${r.uri} (${r.mimeType})`).join(', ')}`);

  for (const resource of resources.resources) {
    const read = await request('resources/read', { uri: resource.uri });
    const html = read.contents[0].text;
    if (!html.startsWith('<!doctype html>')) throw new Error(`${resource.uri} is not html`);
    console.log(`  ${resource.uri} reads back ${(html.length / 1024).toFixed(0)} kB of html`);
  }

  const folders = await timed('list_folders', () =>
    request('tools/call', { name: 'list_folders', arguments: {} })
  );
  console.log(`  ${folders.structuredContent.totalBookmarks} bookmarks across the tree`);

  const search = await timed('search_bookmarks (cold, embeds the library)', () =>
    request('tools/call', { name: 'search_bookmarks', arguments: { query: 'invoices and billing', limit: 5 } })
  );
  if (search.structuredContent.degraded) console.log(`  degraded: ${search.structuredContent.note}`);
  for (const hit of search.structuredContent.hits) {
    console.log(`    ${hit.title}  ${hit.folderPath}`);
  }

  const warm = await timed('search_bookmarks (warm)', () =>
    request('tools/call', { name: 'search_bookmarks', arguments: { query: 'rust programming', limit: 5 } })
  );
  for (const hit of warm.structuredContent.hits) {
    console.log(`    ${hit.title}  ${hit.folderPath}`);
  }

  const dupes = await timed('propose_reorg duplicates', () =>
    request('tools/call', { name: 'propose_reorg', arguments: { generate: 'duplicates' } })
  );
  console.log(`  ${dupes.structuredContent.rows.length} duplicate rows, valid=${dupes.structuredContent.valid}`);

  const bridge = await request('tools/call', { name: 'bridge_status', arguments: {} });
  console.log(`  extension connected: ${bridge.structuredContent.connected}`);

  console.log('\nsmoke test passed');
} catch (err) {
  failed = true;
  console.error(`\nsmoke test failed: ${err.message}`);
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
