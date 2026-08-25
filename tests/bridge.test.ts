import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Bridge } from '../src/server/bridge.js';

let bridge: Bridge | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
  });
}

function pairedClient(port: number, onApply: (msg: any, ws: WebSocket) => void): Promise<WebSocket> {
  return new Promise(async resolve => {
    const ws = await connect(port);
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'welcome') return resolve(ws);
      if (msg.type === 'apply') onApply(msg, ws);
    });
    ws.send(JSON.stringify({ type: 'hello', token: 'good' }));
  });
}

describe('Bridge', () => {
  it('rejects a client with a bad token', async () => {
    bridge = new Bridge({ port: 45711, token: 'good' });
    await bridge.start();
    const ws = await connect(45711);
    const reply = await new Promise<any>(resolve => {
      ws.on('message', raw => resolve(JSON.parse(String(raw))));
      ws.send(JSON.stringify({ type: 'hello', token: 'bad' }));
    });
    expect(reply.type).toBe('reject');
    ws.close();
  });

  it('reports not connected before a client says hello', async () => {
    bridge = new Bridge({ port: 45712, token: 'good' });
    await bridge.start();
    expect(bridge.isConnected()).toBe(false);
  });

  it('round trips an apply to a paired client', async () => {
    bridge = new Bridge({ port: 45713, token: 'good' });
    await bridge.start();
    const ws = await pairedClient(45713, (msg, sock) => {
      sock.send(JSON.stringify({ type: 'result', id: msg.id, applied: [{ tempId: 't1', newId: '42' }] }));
    });
    const applied = await bridge.apply([
      { op: 'create_folder', tempId: 't1', parentId: '1', title: 'Rust' }
    ]);
    expect(applied).toEqual([{ tempId: 't1', newId: '42' }]);
    ws.close();
  });

  it('reports connected once a client has paired', async () => {
    bridge = new Bridge({ port: 45716, token: 'good' });
    await bridge.start();
    const ws = await pairedClient(45716, () => {});
    expect(bridge.isConnected()).toBe(true);
    ws.close();
  });

  it('rejects apply with an actionable message when no client is paired', async () => {
    bridge = new Bridge({ port: 45714, token: 'good' });
    await bridge.start();
    await expect(bridge.apply([{ op: 'delete', id: '1' }])).rejects.toThrow(/extension/i);
  });

  it('surfaces a client side op failure with the failing index', async () => {
    bridge = new Bridge({ port: 45715, token: 'good' });
    await bridge.start();
    const ws = await pairedClient(45715, (msg, sock) => {
      sock.send(JSON.stringify({ type: 'error', id: msg.id, index: 1, message: 'no such node' }));
    });
    await expect(bridge.apply([{ op: 'delete', id: '1' }])).rejects.toThrow(/index 1/);
    ws.close();
  });

  it('times out an apply the client never answers', async () => {
    bridge = new Bridge({ port: 45717, token: 'good' });
    await bridge.start();
    const ws = await pairedClient(45717, () => {});
    await expect(bridge.apply([{ op: 'delete', id: '1' }], 100)).rejects.toThrow(/timed out/i);
    ws.close();
  });

  it('carries the failed op index on the thrown error object', async () => {
    bridge = new Bridge({ port: 45718, token: 'good' });
    await bridge.start();
    const ws = await pairedClient(45718, (msg, sock) => {
      sock.send(JSON.stringify({ type: 'error', id: msg.id, index: 2, message: 'boom' }));
    });
    await expect(bridge.apply([{ op: 'delete', id: '1' }])).rejects.toMatchObject({ failedIndex: 2 });
    ws.close();
  });
});
