// Message de commit conventionnel (sans dépendance à VS Code ni au DOM : utilisé par la webview et testé) :
// types proposés avec leur icône, lecture et écriture du préfixe « type(scope)!: ».

export interface CommitType {
  type: string;
  /** Icône affichée dans l'interface seulement (jamais écrite dans le message). */
  icon: string;
}

export const COMMIT_TYPES: readonly CommitType[] = [
  { type: 'feat', icon: '✨' },
  { type: 'fix', icon: '🐛' },
  { type: 'refactor', icon: '♻️' },
  { type: 'perf', icon: '⚡' },
  { type: 'style', icon: '💄' },
  { type: 'docs', icon: '📝' },
  { type: 'test', icon: '✅' },
  { type: 'build', icon: '📦' },
  { type: 'ci', icon: '👷' },
  { type: 'chore', icon: '🔧' },
  { type: 'revert', icon: '⏪' },
];

export interface Prefix {
  /** undefined : pas de préfixe. */
  type: string | undefined;
  scope: string;
  breaking: boolean;
}

const PREFIX = /^([a-z]+)(?:\(([^)\n]*)\))?(!)?: ?/;

/** Préfixe conventionnel en tête du message (seulement pour un type proposé), et le reste du message. */
export function readPrefix(message: string): Prefix & { rest: string } {
  const match = PREFIX.exec(message);
  if (!match || !COMMIT_TYPES.some((t) => t.type === match[1])) return { type: undefined, scope: '', breaking: false, rest: message };
  return { type: match[1], scope: match[2] ?? '', breaking: match[3] === '!', rest: message.slice(match[0].length) };
}

/** Message avec le préfixe donné à la place de l'éventuel préfixe actuel (sans préfixe si `type` est undefined). */
export function writePrefix(message: string, prefix: Prefix): string {
  const { rest } = readPrefix(message);
  if (!prefix.type) return rest;
  const scope = prefix.scope.trim();
  return `${prefix.type}${scope ? `(${scope})` : ''}${prefix.breaking ? '!' : ''}: ${rest}`;
}

/** Longueur de la première ligne (le résumé). */
export function summaryLength(message: string): number {
  return message.split('\n')[0].length;
}

/** Au moins un fichier indexé et du texte après le préfixe. */
export function canCommit(message: string, stagedCount: number): boolean {
  return stagedCount > 0 && readPrefix(message).rest.trim() !== '';
}
