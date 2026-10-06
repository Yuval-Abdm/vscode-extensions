// Rebase interactif (sans dépendance à VS Code) : validation, message proposé pour un squash, liste de tâches pour
// git, lecture et écriture d'un fichier git-rebase-todo.
//
// Reword et squash ne passent pas par l'éditeur de git : « pick X » (ou « fixup X ») est suivi d'un
// « exec sh 'amend-N.sh' » qui change le message de HEAD. Le script vérifie d'abord que HEAD est bien le commit
// attendu (auteur, date et message à ce moment-là) : si X a été passé (« skip » après un conflit), HEAD est un autre
// commit et rien n'est modifié.

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseItem {
  sha: string;
  summary: string;
  /** Message complet d'origine. */
  message: string;
  /** Auteur et date d'origine : « nom <e-mail> secondes ». */
  ident: string;
  action: RebaseAction;
  /** reword / squash : message final choisi. */
  newMessage?: string;
}

export function validateRebase(items: readonly RebaseItem[]): 'empty' | 'squash-first' | undefined {
  const kept = items.filter((item) => item.action !== 'drop');
  if (!kept.length) return 'empty';
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') return 'squash-first';
  return undefined;
}

/**
 * Nettoyage de git (`--cleanup=whitespace`) : espaces de fin de ligne, lignes vides en tête et en fin, lignes vides
 * consécutives réduites à une. Le message écrit et le message attendu sont ainsi comparables.
 */
export function cleanupMessage(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Tête du groupe de squash / fixup qui se termine en `index` (dernier commit gardé qui n'est ni squash ni fixup). */
function groupHead(items: readonly RebaseItem[], index: number): number {
  let head = index - 1;
  while (head > 0 && ['squash', 'fixup', 'drop'].includes(items[head].action)) head--;
  return Math.max(head, 0);
}

/** Message final d'un commit gardé : reformulé (reword) ou d'origine. */
function finalMessage(item: RebaseItem): string {
  return item.action === 'reword' && item.newMessage !== undefined ? item.newMessage : item.message;
}

/** Message proposé pour le squash `index` : message de la tête du groupe, puis ceux des squash jusqu'à lui. */
export function squashMessage(items: readonly RebaseItem[], index: number): string {
  const head = groupHead(items, index);
  const parts = [finalMessage(items[head])];
  for (let i = head + 1; i <= index; i++) {
    if (items[i].action === 'squash') parts.push(items[i].message);
  }
  return parts.join('\n\n');
}

/** Une réécriture de message : le script vérifie que HEAD a `ident` et `expected` comme message avant d'amender. */
export interface Amend {
  index: number;
  sha: string;
  ident: string;
  /** Message de HEAD attendu juste avant l'exec. */
  expected: string;
  message: string;
}

/** Liste de tâches git ; `scriptFor` écrit le script d'une réécriture et renvoie son chemin. */
export function buildTodo(items: readonly RebaseItem[], scriptFor: (amend: Amend) => string): string {
  const lines: string[] = [];
  /** Message de HEAD après chaque tâche du groupe en cours. */
  let current = '';
  items.forEach((item, index) => {
    switch (item.action) {
      case 'drop':
        lines.push(`drop ${item.sha}`);
        break;
      case 'pick':
      case 'edit':
        lines.push(`${item.action} ${item.sha}`);
        current = item.message;
        break;
      case 'fixup':
        lines.push(`fixup ${item.sha}`);
        break;
      case 'reword': {
        lines.push(`pick ${item.sha}`);
        const message = cleanupMessage(item.newMessage ?? item.message);
        if (message !== cleanupMessage(item.message)) {
          lines.push(`exec sh ${shellQuote(scriptFor({ index, sha: item.sha, ident: item.ident, expected: item.message, message }))}`);
        }
        current = message;
        break;
      }
      case 'squash': {
        lines.push(`fixup ${item.sha}`);
        const head = items[groupHead(items, index)];
        const message = cleanupMessage(item.newMessage ?? squashMessage(items, index));
        lines.push(`exec sh ${shellQuote(scriptFor({ index, sha: item.sha, ident: head.ident, expected: current, message }))}`);
        current = message;
        break;
      }
    }
  });
  return lines.join('\n');
}

/** Chemin ou texte entre apostrophes pour sh (aucune expansion : $, `, " restent tels quels). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Contenu du script d'une réécriture ; les fichiers du message et du message attendu sont à côté. */
export function amendScript(amend: Amend, messageFile: string, expectedFile: string): string {
  return [
    `# Git Forge : message du commit ${amend.sha}, appliqué seulement si HEAD est bien ce commit.`,
    `if [ "$(git show -s --no-show-signature --format='%an <%ae> %at' HEAD)" = ${shellQuote(amend.ident)} ] &&`,
    `   [ "$(git show -s --no-show-signature --format=%B HEAD)" = "$(cat ${shellQuote(expectedFile)})" ]; then`,
    `  git commit --amend --allow-empty --quiet --cleanup=whitespace -F ${shellQuote(messageFile)}`,
    'else',
    `  echo "Git Forge: ${amend.sha.slice(0, 8)} was skipped, its new message is not applied." >&2`,
    'fi',
    '',
  ].join('\n');
}

export interface TodoItem {
  action: RebaseAction;
  sha: string;
  summary: string;
}

const ACTIONS: Record<string, RebaseAction> = {
  p: 'pick',
  pick: 'pick',
  r: 'reword',
  reword: 'reword',
  e: 'edit',
  edit: 'edit',
  s: 'squash',
  squash: 'squash',
  f: 'fixup',
  fixup: 'fixup',
  d: 'drop',
  drop: 'drop',
};

/** Lignes d'un git-rebase-todo ; undefined s'il contient autre chose (exec, label, merge, update-ref, fixup -C…). */
export function parseTodo(text: string): TodoItem[] | undefined {
  const items: TodoItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(\S+)\s+([0-9a-f]{4,64})(?:\s+(.*))?$/.exec(line);
    const action = match && ACTIONS[match[1]];
    if (!match || !action) return undefined;
    items.push({ action, sha: match[2], summary: match[3] ?? '' });
  }
  return items;
}

export function serializeTodo(items: readonly TodoItem[]): string {
  return items.map((item) => `${item.action} ${item.sha} ${item.summary}`.trimEnd() + '\n').join('');
}
