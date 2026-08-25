import type { Op } from '../server/plan.js';

export const DEFAULT_PORT = 45732;

export interface AppliedOp {
  tempId?: string;
  newId?: string;
}

export type ClientMessage =
  | { type: 'hello'; token: string }
  | { type: 'result'; id: string; applied: AppliedOp[] }
  | { type: 'error'; id: string; index: number; message: string }
  | { type: 'pong' };

export type ServerMessage =
  | { type: 'welcome' }
  | { type: 'reject'; reason: string }
  | { type: 'apply'; id: string; ops: Op[] }
  | { type: 'ping' };

export const NOT_CONNECTED_MESSAGE =
  'Chrome extension is not connected. Open Chrome, confirm the chrome-bookmarks-mcp extension ' +
  'is enabled at chrome://extensions, and check the pairing token in its options page.';
