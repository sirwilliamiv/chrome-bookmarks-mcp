import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';

/** Required by the MCP Apps extension. Any other value and the host will not render the view. */
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

const here = dirname(fileURLToPath(import.meta.url));
// dist/server/views.js sits two levels below the package root, and the views
// are built to views/dist next to it
const viewsDist = join(here, '..', '..', 'views', 'dist');

export interface UiResource {
  uri: string;
  name: string;
  description: string;
  file: string;
  mimeType: typeof APP_MIME_TYPE;
}

export const UI_RESOURCES: UiResource[] = [
  {
    uri: 'ui://bookmarks/explorer',
    name: 'Bookmark explorer',
    description: 'Folder tree and search results for the Chrome bookmark library.',
    file: join(viewsDist, 'explorer.html')
  },
  {
    uri: 'ui://bookmarks/review',
    name: 'Reorganization review',
    description: 'Interactive diff of a proposed bookmark reorganization, with per row approval.',
    file: join(viewsDist, 'review.html')
  }
].map(resource => ({ ...resource, mimeType: APP_MIME_TYPE as typeof APP_MIME_TYPE }));

export function registerViews(server: McpServer): void {
  for (const resource of UI_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: readFileSync(resource.file, 'utf8')
          }
        ]
      })
    );
  }
}
