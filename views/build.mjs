import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');

const VIEWS = [
  { name: 'explorer', title: 'Bookmark explorer' },
  { name: 'review', title: 'Reorganization review' }
];

/**
 * MCP App views render under `default-src 'none'` with only 'self' and
 * 'unsafe-inline' allowed for script and style, so everything has to be inlined
 * into one file. No external scripts, stylesheets, fonts, or images.
 */
function shell(title, css, js) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js}</script>
</body>
</html>
`;
}

async function buildView({ name, title }) {
  const result = await build({
    entryPoints: [join(here, 'src', `${name}.ts`)],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
    platform: 'browser',
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' }
  });

  const js = result.outputFiles.map(f => f.text).join('\n');
  const css = await readFile(join(here, 'src', `${name}.css`), 'utf8');
  const html = shell(title, css, js);

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${name}.html`);
  await writeFile(outPath, html);
  return { outPath, bytes: Buffer.byteLength(html) };
}

for (const view of VIEWS) {
  const { outPath, bytes } = await buildView(view);
  console.log(`built ${outPath} (${(bytes / 1024).toFixed(1)} kB)`);
}
