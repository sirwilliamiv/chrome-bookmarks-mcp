#!/usr/bin/env node
/**
 * Control the shared daemon: status, start, stop, restart, logs.
 * Clients start it on demand, so this is only needed to inspect or recycle it.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const daemonPath = join(root, 'dist', 'server', 'daemon.js');
const stateHome = process.env.CHROME_BOOKMARKS_MCP_HOME ?? join(homedir(), '.chrome-bookmarks-mcp');
const pidFile = join(stateHome, 'daemon.pid');
const logFile = join(stateHome, 'daemon.log');
const port = Number(process.env.CHROME_BOOKMARKS_MCP_HTTP_PORT) || 45731;

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function readPid() {
  try {
    return Number(readFileSync(pidFile, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

async function start() {
  if (await health()) {
    console.log('already running');
    return status();
  }
  if (!existsSync(daemonPath)) {
    console.error(`daemon not built at ${daemonPath}. Run pnpm build.`);
    process.exit(1);
  }
  const { openSync } = await import('node:fs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(stateHome, { recursive: true });
  const out = openSync(logFile, 'a');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await health()) return status();
  }
  console.error(`daemon did not come up. Check ${logFile}`);
  process.exit(1);
}

async function stop() {
  const info = await health();
  const pid = info?.pid ?? readPid();
  if (!pid) {
    console.log('not running');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`could not stop pid ${pid}: ${err.message}`);
    process.exit(1);
  }
  // shutdown drains open connections first, so wait for the port to go dark
  for (let i = 0; i < 50; i++) {
    if (!(await health())) {
      console.log(`stopped pid ${pid}`);
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.error(`pid ${pid} is still answering after 5s`);
  process.exit(1);
}

async function status() {
  const info = await health();
  if (!info) {
    console.log('stopped');
    return;
  }
  console.log(`running   pid ${info.pid}`);
  console.log(`mcp       http://127.0.0.1:${port}/mcp`);
  console.log(`bridge    127.0.0.1:${info.bridgePort}`);
  console.log(`extension ${info.extensionConnected ? 'connected' : 'not connected'}`);
}

const command = process.argv[2] ?? 'status';

if (command === 'status') await status();
else if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'restart') {
  await stop();
  await start();
} else if (command === 'restart-if-running') {
  // used by pnpm build so a rebuilt daemon replaces the stale one
  if (await health()) {
    await stop();
    await start();
  } else {
    console.log('daemon not running, nothing to restart');
  }
} else if (command === 'logs') {
  if (!existsSync(logFile)) console.log(`no log yet at ${logFile}`);
  else console.log(readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'));
} else {
  console.error('usage: daemon.mjs [status|start|stop|restart|restart-if-running|logs]');
  process.exit(1);
}
