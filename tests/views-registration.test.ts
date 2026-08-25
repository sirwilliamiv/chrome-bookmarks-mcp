import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { UI_RESOURCES, APP_MIME_TYPE } from '../src/server/views.js';

describe('view resources', () => {
  it('declares both views with the exact mcp-app mimetype', () => {
    expect(UI_RESOURCES).toHaveLength(2);
    for (const resource of UI_RESOURCES) {
      expect(resource.uri.startsWith('ui://')).toBe(true);
      expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    }
  });

  it('uses the mimetype constant the spec mandates', () => {
    expect(APP_MIME_TYPE).toBe('text/html;profile=mcp-app');
  });

  it('has a built html file for each declared view', () => {
    for (const resource of UI_RESOURCES) {
      expect(existsSync(resource.file), `missing ${resource.file}, run pnpm build:views`).toBe(true);
    }
  });

  it('ships self contained html with no external subresources', () => {
    for (const resource of UI_RESOURCES) {
      const html = readFileSync(resource.file, 'utf8');
      expect(html).not.toMatch(/<script[^>]+\ssrc=/);
      expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/);
      expect(html).not.toMatch(/@import\s+url\(/);
    }
  });

  it('never fetches at runtime, which the view CSP forbids', () => {
    for (const resource of UI_RESOURCES) {
      const html = readFileSync(resource.file, 'utf8');
      expect(html).not.toMatch(/\bfetch\s*\(/);
      expect(html).not.toMatch(/XMLHttpRequest/);
    }
  });
});
