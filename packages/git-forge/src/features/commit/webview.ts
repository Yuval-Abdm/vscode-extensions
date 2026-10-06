/// <reference lib="dom" />
// Vue « Commit » (webview, regroupée par esbuild dans dist/commit-view.js) : types de commit conventionnels avec
// icône, message, pull avant commit, Commit / Commit & Push, fichiers indexés et non indexés avec case à cocher.
// Aucun texte venant de git n'est inséré en HTML : textContent uniquement.
import { canCommit, COMMIT_TYPES, readPrefix, summaryLength, writePrefix } from './message.ts';

interface Change {
  path: string;
  oldPath?: string;
  status: string;
}

interface ViewState {
  type: 'state';
  root: string;
  repo: string;
  branch: string;
  upstream?: string;
  staged: Change[];
  unstaged: Change[];
  pull: boolean;
}

interface Strings {
  types: Record<string, string>;
  noType: string;
  staged: string;
  unstaged: string;
  stageAll: string;
  unstageAll: string;
  noRepo: string;
  noChanges: string;
  noUpstream: string;
  status: Record<string, string>;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

const SUMMARY_MAX = 72;
const vscode = acquireVsCodeApi();
const strings = JSON.parse((document.getElementById('strings') as HTMLElement).textContent ?? '{}') as Strings;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const type = byId<HTMLSelectElement>('type');
const scope = byId<HTMLInputElement>('scope');
const breaking = byId<HTMLInputElement>('breaking');
const message = byId<HTMLTextAreaElement>('message');
const counter = byId<HTMLSpanElement>('counter');
const pull = byId<HTMLInputElement>('pull');
const pullHint = byId<HTMLSpanElement>('pull-hint');
const commit = byId<HTMLButtonElement>('commit');
const commitPush = byId<HTMLButtonElement>('commit-push');
const branch = byId<HTMLDivElement>('branch');
const files = byId<HTMLDivElement>('files');

let state: ViewState | undefined;
let busy = false;

const saved = vscode.getState() as { message?: string } | undefined;
message.value = saved?.message ?? '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Liste déroulante des types : « type… » (aucun préfixe), puis chaque type avec son icône et sa description.
const none = el('option', '', strings.noType);
none.value = '';
type.appendChild(none);
for (const commitType of COMMIT_TYPES) {
  const option = el('option', '', `${commitType.icon} ${commitType.type} — ${strings.types[commitType.type] ?? ''}`);
  option.value = commitType.type;
  type.appendChild(option);
}
type.addEventListener('change', () => {
  message.value = writePrefix(message.value, { type: type.value || undefined, scope: scope.value, breaking: breaking.checked });
  edited();
  message.focus();
  const end = message.value.split('\n')[0].length;
  message.setSelectionRange(end, end);
});

/** Scope ou breaking changé : réécrit le préfixe s'il y a un type. */
function rewritePrefix(): void {
  const { type } = readPrefix(message.value);
  if (!type) return;
  message.value = writePrefix(message.value, { type, scope: scope.value, breaking: breaking.checked });
  edited();
}

scope.addEventListener('input', rewritePrefix);
breaking.addEventListener('change', rewritePrefix);
/** Préfixe tapé à la main ou message restauré : la liste, le scope et la case suivent. */
function syncOptions(): void {
  const prefix = readPrefix(message.value);
  type.value = prefix.type ?? '';
  if (!prefix.type) return;
  if (document.activeElement !== scope) scope.value = prefix.scope;
  breaking.checked = prefix.breaking;
}

syncOptions();
message.addEventListener('input', () => {
  syncOptions();
  edited();
});
message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send(false);
  }
});
pull.addEventListener('change', () => post({ type: 'setPull', value: pull.checked }));
commit.addEventListener('click', () => send(false));
commitPush.addEventListener('click', () => send(true));

/** Message vers l'extension, avec le dépôt affiché (refusé par l'extension s'il a changé entre-temps). */
function post(data: Record<string, unknown>): void {
  vscode.postMessage({ ...data, root: state?.root });
}

function edited(): void {
  vscode.setState({ message: message.value });
  update();
}

function update(): void {
  const length = summaryLength(message.value);
  counter.textContent = `${length}/${SUMMARY_MAX}`;
  counter.classList.toggle('long', length > SUMMARY_MAX);
  const disabled = busy || !state || !canCommit(message.value, state.staged.length);
  commit.disabled = disabled;
  commitPush.disabled = disabled;
}

function send(push: boolean): void {
  if (commit.disabled) return;
  busy = true;
  update();
  post({ type: 'commit', message: message.value, push });
}

/** Chemins d'un changement : un renommage désindexé l'est des deux côtés (ancien et nouveau chemin). */
function pathsOf(change: Change): string[] {
  return change.oldPath ? [change.path, change.oldPath] : [change.path];
}

function group(title: string, changes: Change[], staged: boolean): HTMLElement {
  const section = el('section', 'group');
  const header = el('label', 'group-header');
  const all = el('input');
  all.type = 'checkbox';
  all.checked = staged;
  all.title = staged ? strings.unstageAll : strings.stageAll;
  // Les fichiers en conflit ne sont jamais indexés en masse : ce serait les marquer résolus.
  const selectable = changes.filter((change) => change.status !== 'U');
  all.disabled = !selectable.length;
  all.addEventListener('change', () => post({ type: staged ? 'unstage' : 'stage', paths: selectable.flatMap(pathsOf) }));
  header.appendChild(all);
  header.appendChild(el('span', 'group-title', `${title} (${changes.length})`));
  section.appendChild(header);
  for (const change of changes) {
    const row = el('div', 'file');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = staged;
    box.title = staged ? strings.unstageAll : strings.stageAll;
    if (change.status === 'U') {
      // Conflit : à résoudre (vue Conflits), pas à cocher.
      box.disabled = true;
      box.title = strings.status.U ?? '';
    }
    box.addEventListener('change', () => post({ type: staged ? 'unstage' : 'stage', paths: pathsOf(change) }));
    row.appendChild(box);
    // Comme VS Code : U = non suivi ; un conflit s'affiche « ! ».
    const letter = change.status === '?' ? 'U' : change.status === 'U' ? '!' : change.status;
    const status = el('span', `status s-${change.status === '?' ? 'u' : change.status}`, letter);
    status.title = strings.status[change.status] ?? change.status;
    row.appendChild(status);
    const slash = change.path.lastIndexOf('/');
    const name = el('span', 'name', change.path.slice(slash + 1));
    name.title = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
    name.addEventListener('click', () => post({ type: 'open', change, staged }));
    row.appendChild(name);
    if (slash > 0) row.appendChild(el('span', 'dir', change.path.slice(0, slash)));
    section.appendChild(row);
  }
  return section;
}

function render(): void {
  if (!state || !state.repo) {
    branch.textContent = strings.noRepo;
    files.replaceChildren();
    update();
    return;
  }
  branch.textContent = `${state.repo} · ${state.branch}${state.upstream ? ` → ${state.upstream}` : ''}`;
  pull.checked = state.pull;
  pullHint.textContent = state.upstream ? '' : strings.noUpstream;
  const groups = [group(strings.staged, state.staged, true), group(strings.unstaged, state.unstaged, false)];
  if (!state.staged.length && !state.unstaged.length) groups.push(el('p', 'empty', strings.noChanges));
  files.replaceChildren(...groups);
  update();
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type: string; busy?: boolean };
  if (data.type === 'state') {
    state = event.data as ViewState;
    render();
  } else if (data.type === 'committed') {
    message.value = '';
    scope.value = '';
    breaking.checked = false;
    type.value = '';
    edited();
  } else if (data.type === 'busy') {
    busy = Boolean(data.busy);
    update();
  }
});

update();
vscode.postMessage({ type: 'ready' });
