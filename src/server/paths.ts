import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function stateDir(): string {
  const dir = process.env.CHROME_BOOKMARKS_MCP_HOME ?? join(homedir(), '.chrome-bookmarks-mcp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(...parts: string[]): string {
  const path = join(stateDir(), ...parts);
  if (parts.length > 1) mkdirSync(join(stateDir(), ...parts.slice(0, -1)), { recursive: true });
  return path;
}
