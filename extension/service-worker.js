import { applyOps } from './apply-ops.js';

const DEFAULT_PORT = 45732;
const KEEPALIVE_ALARM = 'cbm-keepalive';
const MAX_BACKOFF_MS = 30_000;

let socket = null;
let backoffMs = 1000;
let status = { connected: false, detail: 'not started' };

async function settings() {
  const stored = await chrome.storage.local.get(['token', 'port']);
  return { token: stored.token ?? '', port: Number(stored.port) || DEFAULT_PORT };
}

function setStatus(connected, detail) {
  status = { connected, detail };
  chrome.storage.local.set({ status });
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function handleApply(message) {
  try {
    const applied = await applyOps(message.ops, chrome.bookmarks);
    send({ type: 'result', id: message.id, applied });
  } catch (err) {
    send({
      type: 'error',
      id: message.id,
      index: typeof err.index === 'number' ? err.index : 0,
      message: err.message || String(err)
    });
  }
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const { token, port } = await settings();
  if (!token) {
    setStatus(false, 'No pairing token set. Open the options page and paste the token from the server log.');
    return;
  }

  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (err) {
    setStatus(false, `Could not open a socket: ${err.message}`);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    send({ type: 'hello', token });
  });

  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'welcome') {
      backoffMs = 1000;
      setStatus(true, `Paired with the server on port ${port}.`);
      return;
    }
    if (message.type === 'reject') {
      setStatus(false, message.reason);
      socket.close();
      return;
    }
    if (message.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (message.type === 'apply') {
      handleApply(message);
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    setStatus(false, 'Disconnected from the server. Is it running?');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    setStatus(false, `Could not reach the server on port ${port}.`);
  });
}

function scheduleReconnect() {
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  setTimeout(connect, delay);
}

// The alarm covers the case where the service worker was evicted between pings.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener(changes => {
  if (changes.token || changes.port) {
    if (socket) socket.close();
    backoffMs = 1000;
    connect();
  }
});

connect();
