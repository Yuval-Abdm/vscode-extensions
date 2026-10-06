/// <reference lib="dom" />
// Vue « Commit » (webview, regroupée par esbuild dans dist/commit-view.js) : sélecteur de type conventionnel avec
// icône, message, pull avant commit, Commit / Commit & Push, fichiers indexés et non indexés (+ / − au survol).
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
  commit: string;
  commitPush: string;
  staged: string;
  unstaged: string;
  stageAll: string;
  unstageAll: string;
  noRepo: string;
  noChanges: string;
  noUpstream: string;
  switchBranch: string;
  discard: string;
  status: Record<string, string>;
}

interface Saved {
  message?: string;
  collapsed?: { staged?: boolean; unstaged?: boolean };
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

const SUMMARY_MAX = 72;
const vscode = acquireVsCodeApi();
const strings = JSON.parse((document.getElementById('strings') as HTMLElement).textContent ?? '{}') as Strings;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const type = byId<HTMLButtonElement>('type');
const typeList = byId<HTMLUListElement>('type-list');
const scope = byId<HTMLInputElement>('scope');
const breaking = byId<HTMLButtonElement>('breaking');
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
/** Type choisi dans la liste (undefined : aucun préfixe). */
let typeValue: string | undefined;

const saved = (vscode.getState() ?? {}) as Saved;
const collapsed = { staged: false, unstaged: false, ...saved.collapsed };
message.value = saved.message ?? '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Icônes en SVG tracé (pas de police d'icônes à charger dans la webview).
const ICONS = {
  check: 'M3 8.5l3 3 7-7',
  push: 'M8 13V3M4 7l4-4 4 4',
  chevron: 'M6 4l4 4-4 4',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  discard: 'M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7',
  branch: 'M5 2.5v8M11 5.5c0 3-6 2-6 5M5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  caret: 'M4 6l4 4 4-4',
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.appendChild(path);
  return svg;
}

commit.append(icon('check'), el('span', '', strings.commit));
commitPush.append(icon('push'), el('span', '', strings.commitPush));

// Sélecteur de type : pastille « ✨ feat ▾ » ; la liste ouverte montre icône, type et description.
const TYPE_OPTIONS = [{ type: undefined as string | undefined, icon: '', label: strings.noType, description: '' }].concat(
  COMMIT_TYPES.map((commitType) => ({ type: commitType.type as string | undefined, icon: commitType.icon, label: commitType.type, description: strings.types[commitType.type] ?? '' })),
);

function renderType(): void {
  const current = TYPE_OPTIONS.find((option) => option.type === typeValue) ?? TYPE_OPTIONS[0];
  type.replaceChildren();
  if (current.icon) type.appendChild(el('span', 'type-icon', current.icon));
  type.appendChild(el('span', current.type ? 'type-label' : 'type-label placeholder', current.label));
  type.appendChild(icon('caret'));
  type.title = current.description || type.title;
  type.classList.toggle('chosen', Boolean(current.type));
}

function openTypes(): void {
  typeList.replaceChildren();
  for (const option of TYPE_OPTIONS) {
    const item = el('li', 'type-option');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.type === typeValue));
    item.tabIndex = -1;
    item.appendChild(el('span', 'type-icon', option.icon));
    item.appendChild(el('span', option.type ? 'type-label' : 'type-label placeholder', option.label));
    if (option.description) item.appendChild(el('span', 'type-description', option.description));
    item.addEventListener('click', () => chooseType(option.type));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        chooseType(option.type);
      }
    });
    typeList.appendChild(item);
  }
  typeList.hidden = false;
  type.setAttribute('aria-expanded', 'true');
  const selected = typeList.querySelector<HTMLElement>('[aria-selected="true"]') ?? typeList.firstElementChild as HTMLElement;
  selected.focus();
}

function closeTypes(focus: boolean): void {
  if (typeList.hidden) return;
  typeList.hidden = true;
  type.setAttribute('aria-expanded', 'false');
  if (focus) type.focus();
}

function chooseType(value: string | undefined): void {
  closeTypes(false);
  typeValue = value;
  renderType();
  message.value = writePrefix(message.value, { type: value, scope: scope.value, breaking: isBreaking() });
  edited();
  message.focus();
  const end = message.value.split('\n')[0].length;
  message.setSelectionRange(end, end);
}

type.addEventListener('click', () => (typeList.hidden ? openTypes() : closeTypes(true)));
typeList.addEventListener('keydown', (event) => {
  const items = Array.from(typeList.children) as HTMLElement[];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  } else if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    closeTypes(true);
  }
});
document.addEventListener('mousedown', (event) => {
  if (!(event.target as Element).closest('.type-picker')) closeTypes(false);
});

function isBreaking(): boolean {
  return breaking.getAttribute('aria-pressed') === 'true';
}

function setBreaking(value: boolean): void {
  breaking.setAttribute('aria-pressed', String(value));
}

/** Scope ou breaking changé : réécrit le préfixe s'il y a un type. */
function rewritePrefix(): void {
  const { type } = readPrefix(message.value);
  if (!type) return;
  message.value = writePrefix(message.value, { type, scope: scope.value, breaking: isBreaking() });
  edited();
}

scope.addEventListener('input', rewritePrefix);
breaking.addEventListener('click', () => {
  setBreaking(!isBreaking());
  rewritePrefix();
});
/** Préfixe tapé à la main ou message restauré : la liste, le scope et le bouton « ! » suivent. */
function syncOptions(): void {
  const prefix = readPrefix(message.value);
  typeValue = prefix.type;
  renderType();
  if (!prefix.type) return;
  if (document.activeElement !== scope) scope.value = prefix.scope;
  setBreaking(prefix.breaking);
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

function save(): void {
  vscode.setState({ message: message.value, collapsed } satisfies Saved);
}

function edited(): void {
  save();
  update();
}

function update(): void {
  const length = summaryLength(message.value);
  counter.textContent = `${length}/${SUMMARY_MAX}`;
  counter.classList.toggle('long', length > SUMMARY_MAX);
  const disabled = busy || !state || !canCommit(message.value, state.staged.length);
  commit.disabled = disabled;
  commitPush.disabled = disabled;
  document.body.classList.toggle('busy', busy);
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

/** Petit bouton rond d'action (indexer / désindexer), visible au survol. */
function action(name: 'plus' | 'minus' | 'discard', title: string, run: () => void): HTMLButtonElement {
  const button = el('button', 'action');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.appendChild(icon(name));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

function group(key: 'staged' | 'unstaged', changes: Change[]): HTMLElement {
  const staged = key === 'staged';
  const verb = staged ? strings.unstageAll : strings.stageAll;
  const section = el('section', collapsed[key] ? 'group collapsed' : 'group');
  const header = el('div', 'group-header');
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', String(!collapsed[key]));
  header.appendChild(icon('chevron'));
  header.appendChild(el('span', 'group-title', staged ? strings.staged : strings.unstaged));
  // Les fichiers en conflit ne sont jamais indexés en masse : ce serait les marquer résolus.
  const selectable = changes.filter((change) => change.status !== 'U');
  // Annuler tout (non indexé uniquement), comme dans la vue Contrôle de code source.
  if (!staged && selectable.length) header.appendChild(action('discard', strings.discard, () => post({ type: 'discard', changes: selectable })));
  if (selectable.length) header.appendChild(action(staged ? 'minus' : 'plus', verb, () => post({ type: staged ? 'unstage' : 'stage', paths: selectable.flatMap(pathsOf) })));
  header.appendChild(el('span', 'badge', String(changes.length)));
  const toggle = () => {
    collapsed[key] = !collapsed[key];
    save();
    render();
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
  section.appendChild(header);
  if (collapsed[key]) return section;
  for (const change of changes) {
    const row = el('div', 'file');
    row.tabIndex = 0;
    const slash = change.path.lastIndexOf('/');
    const name = el('span', 'name', change.path.slice(slash + 1));
    row.title = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
    row.appendChild(name);
    if (slash > 0) row.appendChild(el('span', 'dir', change.path.slice(0, slash)));
    row.appendChild(el('span', 'spacer'));
    // Conflit : à résoudre (vue Conflits), pas à indexer.
    if (change.status !== 'U' && !staged) row.appendChild(action('discard', strings.discard, () => post({ type: 'discard', changes: [change] })));
    if (change.status !== 'U') row.appendChild(action(staged ? 'minus' : 'plus', verb, () => post({ type: staged ? 'unstage' : 'stage', paths: pathsOf(change) })));
    // Comme VS Code : U = non suivi ; un conflit s'affiche « ! ».
    const letter = change.status === '?' ? 'U' : change.status === 'U' ? '!' : change.status;
    const status = el('span', `status s-${change.status === '?' ? 'u' : change.status}`, letter);
    status.title = strings.status[change.status] ?? change.status;
    row.appendChild(status);
    const open = () => post({ type: 'open', change, staged });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') open();
    });
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
  // Pastille cliquable : choix de la branche à extraire.
  const chip = el('button', 'branch-chip');
  chip.type = 'button';
  chip.title = strings.switchBranch;
  chip.append(icon('branch'), el('span', 'branch-name', state.branch));
  if (state.upstream) chip.append(el('span', 'upstream', `→ ${state.upstream}`));
  chip.addEventListener('click', () => post({ type: 'switchBranch' }));
  branch.replaceChildren(chip, el('span', 'repo', state.repo));
  pull.checked = state.pull;
  pullHint.textContent = state.upstream ? '' : strings.noUpstream;
  const groups = [group('staged', state.staged), group('unstaged', state.unstaged)];
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
    setBreaking(false);
    typeValue = undefined;
    renderType();
    edited();
  } else if (data.type === 'busy') {
    busy = Boolean(data.busy);
    update();
  }
});

update();
vscode.postMessage({ type: 'ready' });
