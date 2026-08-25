import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { statePath } from './paths.js';
import type { Op } from './plan.js';
import {
  NOT_CONNECTED_MESSAGE,
  type AppliedOp,
  type ClientMessage,
  type ServerMessage
} from '../shared/protocol.js';

const PING_INTERVAL_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BridgeOptions {
  port: number;
  token: string;
}

export class ApplyError extends Error {
  constructor(
    message: string,
    readonly failedIndex: number
  ) {
    super(message);
    this.name = 'ApplyError';
  }
}

interface Pending {
  resolve: (applied: AppliedOp[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getOrCreateToken(): string {
  const path = statePath('token');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through and mint a new one
  }
  const token = randomBytes(16).toString('hex');
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private pingTimer: NodeJS.Timeout | null = null;
  private counter = 0;

  constructor(private readonly options: BridgeOptions) {}

  async start(): Promise<void> {
    if (this.wss) return;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: this.options.port });
    this.wss = wss;

    wss.on('connection', socket => {
      let paired = false;

      socket.on('message', raw => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return;
        }

        if (!paired) {
          if (msg.type !== 'hello' || !tokensMatch(msg.token, this.options.token)) {
            this.send(socket, {
              type: 'reject',
              reason: 'Pairing token does not match. Copy the token from the server log into the extension options page.'
            });
            socket.close();
            return;
          }
          paired = true;
          // a fresh pairing replaces any stale client
          if (this.client && this.client !== socket) this.client.close();
          this.client = socket;
          this.send(socket, { type: 'welcome' });
          return;
        }

        this.handlePaired(msg);
      });

      socket.on('close', () => {
        if (this.client === socket) this.client = null;
      });
      socket.on('error', () => {
        if (this.client === socket) this.client = null;
      });
    });

    this.pingTimer = setInterval(() => {
      if (this.client) this.send(this.client, { type: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
  }

  private handlePaired(msg: ClientMessage): void {
    if (msg.type === 'result') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      pending.resolve(msg.applied);
      return;
    }
    if (msg.type === 'error') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      pending.reject(new ApplyError(`Bookmark op at index ${msg.index} failed: ${msg.message}`, msg.index));
    }
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // a dead socket surfaces through close, nothing useful to do here
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === this.client.OPEN;
  }

  async apply(ops: Op[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AppliedOp[]> {
    if (!this.isConnected()) throw new Error(NOT_CONNECTED_MESSAGE);
    if (!ops.length) return [];

    const client = this.client!;
    const id = `req-${++this.counter}`;

    return new Promise<AppliedOp[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Chrome extension timed out after ${timeoutMs}ms without answering the batch.`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      this.send(client, { type: 'apply', id, ops });
    });
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge stopped before the batch completed.'));
    }
    this.pending.clear();

    this.client?.close();
    this.client = null;

    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>(resolve => wss.close(() => resolve()));
  }
}
