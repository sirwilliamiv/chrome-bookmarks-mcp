import { connectHost, type HostConnection } from './host.js';

export interface TreeNode {
  id: string;
  title: string;
  folderPath: string;
  bookmarkCount: number;
  totalCount: number;
  children: TreeNode[];
}

export interface TreeRow {
  id: string;
  title: string;
  folderPath: string;
  totalCount: number;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export interface BookmarkRow {
  id: string;
  title: string;
  url: string;
  folderPath: string;
}

/** Depth-first walk that only descends into folders the user has opened. */
export function flattenTree(tree: TreeNode[], expanded: Set<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of tree) {
    const isExpanded = expanded.has(node.id);
    rows.push({
      id: node.id,
      title: node.title,
      folderPath: node.folderPath,
      totalCount: node.totalCount,
      depth,
      hasChildren: node.children.length > 0,
      expanded: isExpanded
    });
    if (isExpanded && node.children.length) {
      rows.push(...flattenTree(node.children, expanded, depth + 1));
    }
  }
  return rows;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Deterministic hue so the same site always gets the same mark colour. */
export function markColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${hash} 52% 46%)`;
}

export function initial(title: string, url: string): string {
  const source = title.trim() || hostname(url);
  return (source[0] ?? '?').toUpperCase();
}

interface State {
  tree: TreeNode[];
  expanded: Set<string>;
  rows: BookmarkRow[];
  heading: string;
  subheading: string;
  selectedFolder: string | null;
  loading: boolean;
}

const state: State = {
  tree: [],
  expanded: new Set(),
  rows: [],
  heading: 'Bookmarks',
  subheading: '',
  selectedFolder: null,
  loading: false
};

let host: HostConnection | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderTree(container: HTMLElement): void {
  container.replaceChildren();
  const rows = flattenTree(state.tree, state.expanded);

  if (!rows.length) {
    container.append(el('p', 'empty', 'No folders loaded.'));
    return;
  }

  for (const row of rows) {
    const button = el('button', 'tree-row');
    button.style.paddingLeft = `${8 + row.depth * 14}px`;
    if (state.selectedFolder === row.folderPath) button.classList.add('selected');

    const twisty = el('span', 'twisty', row.hasChildren ? (row.expanded ? '▾' : '▸') : '');
    const label = el('span', 'tree-title', row.title);
    const count = el('span', 'tree-count', String(row.totalCount));
    button.append(twisty, label, count);

    twisty.addEventListener('click', event => {
      event.stopPropagation();
      if (!row.hasChildren) return;
      if (state.expanded.has(row.id)) state.expanded.delete(row.id);
      else state.expanded.add(row.id);
      render();
    });

    button.addEventListener('click', () => {
      state.expanded.add(row.id);
      void selectFolder(row.folderPath);
    });

    container.append(button);
  }
}

function renderResults(container: HTMLElement): void {
  container.replaceChildren();

  if (state.loading) {
    container.append(el('p', 'empty', 'Loading.'));
    return;
  }
  if (!state.rows.length) {
    container.append(el('p', 'empty', 'Nothing to show here.'));
    return;
  }

  for (const row of state.rows) {
    const card = el('button', 'card');

    const mark = el('span', 'mark', initial(row.title, row.url));
    mark.style.background = markColor(hostname(row.url));

    const body = el('span', 'card-body');
    body.append(
      el('span', 'card-title', row.title || hostname(row.url)),
      el('span', 'card-host', hostname(row.url)),
      el('span', 'card-path', row.folderPath)
    );

    card.append(mark, body);
    card.addEventListener('click', () => host?.openLink(row.url));
    container.append(card);
  }
}

function render(): void {
  const tree = document.getElementById('tree')!;
  const results = document.getElementById('results')!;
  document.getElementById('heading')!.textContent = state.heading;
  document.getElementById('subheading')!.textContent = state.subheading;
  renderTree(tree);
  renderResults(results);
}

async function selectFolder(folderPath: string): Promise<void> {
  if (!host) return;
  state.selectedFolder = folderPath;
  state.loading = true;
  state.heading = folderPath;
  state.subheading = 'Loading.';
  render();

  const result = await host.callTool<{ bookmarks: BookmarkRow[]; total: number }>('list_bookmarks', {
    folder: folderPath,
    limit: 200
  });

  state.loading = false;
  state.rows = result?.bookmarks ?? [];
  state.subheading = `${result?.total ?? 0} bookmarks directly in this folder`;
  render();
}

async function runSearch(query: string): Promise<void> {
  if (!host) return;
  if (!query.trim()) {
    state.rows = [];
    state.heading = 'Bookmarks';
    state.subheading = 'Type to search, or pick a folder.';
    render();
    return;
  }

  state.loading = true;
  state.heading = `Results for "${query}"`;
  state.subheading = 'Searching.';
  state.selectedFolder = null;
  render();

  const result = await host.callTool<{
    hits: BookmarkRow[];
    searched: number;
    degraded: boolean;
    note?: string;
  }>('search_bookmarks', { query, limit: 60 });

  state.loading = false;
  state.rows = result?.hits ?? [];
  state.subheading = result
    ? `${result.hits.length} of ${result.searched} bookmarks${result.degraded ? '. ' + (result.note ?? '') : ''}`
    : 'Search failed.';
  render();
}

function applyToolResult(structured: Record<string, unknown> | undefined): void {
  if (!structured) return;

  if (Array.isArray(structured.tree)) {
    state.tree = structured.tree as TreeNode[];
    for (const root of state.tree) state.expanded.add(root.id);
    state.heading = 'Bookmarks';
    state.subheading = `${structured.totalBookmarks ?? 0} bookmarks. Pick a folder or search.`;
  }

  if (Array.isArray(structured.hits)) {
    state.rows = structured.hits as BookmarkRow[];
    state.heading = `Results for "${String(structured.query ?? '')}"`;
    state.subheading = `${state.rows.length} of ${structured.searched ?? 0} bookmarks`;
  }

  if (Array.isArray(structured.bookmarks)) {
    state.rows = structured.bookmarks as BookmarkRow[];
    state.selectedFolder = String(structured.folder ?? '');
    state.heading = state.selectedFolder;
    state.subheading = `${structured.total ?? state.rows.length} bookmarks directly in this folder`;
  }

  render();
}

function layout(): void {
  const root = document.getElementById('root')!;
  root.innerHTML = `
    <div class="shell">
      <aside class="pane-left">
        <div class="pane-head">Folders</div>
        <div id="tree" class="tree"></div>
      </aside>
      <section class="pane-right">
        <div class="search-bar">
          <input id="q" type="search" placeholder="Search bookmarks by meaning or text" spellcheck="false" />
        </div>
        <div class="head">
          <h1 id="heading">Bookmarks</h1>
          <p id="subheading"></p>
        </div>
        <div id="results" class="results"></div>
      </section>
    </div>
  `;

  const input = document.getElementById('q') as HTMLInputElement;
  let debounce: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void runSearch(input.value), 250);
  });
}

async function main(): Promise<void> {
  layout();
  render();
  host = await connectHost({ name: 'bookmark-explorer', version: '0.1.0' }, applyToolResult);

  if (!state.tree.length) {
    const result = await host.callTool<{ tree: TreeNode[]; totalBookmarks: number }>('list_folders');
    applyToolResult(result ?? undefined);
  }
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  void main();
}
