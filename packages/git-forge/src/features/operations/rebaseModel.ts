// Rebase interactif (sans dépendance à VS Code) : validation, message proposé pour un squash, liste de tâches pour
// git (reword et squash passent par « exec git commit --amend -F fichier » : aucun éditeur n'est ouvert), lecture et
// écriture d'un fichier git-rebase-todo.

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseItem {
  sha: string;
  summary: string;
  /** Message complet d'origine. */
  message: string;
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

/** Message proposé pour le squash `index` : message de la tête du groupe, puis ceux des squash jusqu'à lui. */
export function squashMessage(items: readonly RebaseItem[], index: number): string {
  let head = index - 1;
  while (head > 0 && ['squash', 'fixup', 'drop'].includes(items[head].action)) head--;
  const parts = [items[head].newMessage ?? items[head].message];
  for (let i = head + 1; i <= index; i++) {
    if (items[i].action === 'squash') parts.push(i === index ? items[i].message : (items[i].newMessage ?? items[i].message));
  }
  return parts.join('\n\n');
}

function amend(file: string): string {
  return `exec git commit --amend --allow-empty --quiet -F "${file}"`;
}

/** Liste de tâches git ; `messageFile` écrit un message et renvoie le chemin du fichier. */
export function buildTodo(items: readonly RebaseItem[], messageFile: (index: number, message: string) => string): string {
  const lines: string[] = [];
  items.forEach((item, index) => {
    switch (item.action) {
      case 'pick':
      case 'edit':
      case 'drop':
      case 'fixup':
        lines.push(`${item.action} ${item.sha}`);
        break;
      case 'reword': {
        lines.push(`pick ${item.sha}`);
        const message = item.newMessage ?? item.message;
        if (message !== item.message) lines.push(amend(messageFile(index, message)));
        break;
      }
      case 'squash':
        lines.push(`fixup ${item.sha}`);
        lines.push(amend(messageFile(index, item.newMessage ?? squashMessage(items, index))));
        break;
    }
  });
  return lines.join('\n');
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

/** Lignes d'un git-rebase-todo ; undefined s'il contient autre chose (exec, label, merge, fixup -C…). */
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
