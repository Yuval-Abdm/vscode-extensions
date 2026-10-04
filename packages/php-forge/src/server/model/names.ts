// Résolution des noms selon les règles de PHP : namespace courant, imports `use`, noms qualifiés.
import type { NameScope, Position, Range } from '../../shared/types.ts';
import { contains } from './ranges.ts';

const SPECIAL_CLASSES = new Set(['self', 'static', 'parent']);
const NATIVE_TYPES = new Set([
  'int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'null', 'never',
  'false', 'true', 'resource', 'integer', 'boolean', 'double',
]);

export function newScope(namespace: string, range: Range): NameScope {
  return { range, namespace, uses: { class: {}, function: {}, constant: {} } };
}

/** Portée de noms active à une position (la plus récente qui la contient). */
export function scopeAt(scopes: NameScope[], pos: Position): NameScope {
  for (let i = scopes.length - 1; i >= 0; i--) if (contains(scopes[i].range, pos)) return scopes[i];
  return scopes[0] ?? newScope('', { start: pos, end: pos });
}

const join = (namespace: string, name: string) => (namespace ? `${namespace}\\${name}` : name);
const clean = (name: string) => name.replace(/\s+/g, '');

/** Nom complet d'une classe (sans « \ » initial) ; undefined pour self / static / parent et les types natifs. */
export function resolveClassName(name: string, scope: NameScope): string | undefined {
  name = clean(name);
  if (name.startsWith('\\')) return name.slice(1);
  const lower = name.toLowerCase();
  if (SPECIAL_CLASSES.has(lower) || NATIVE_TYPES.has(lower)) return undefined;
  if (lower.startsWith('namespace\\')) return join(scope.namespace, name.slice('namespace\\'.length));
  const [first, ...rest] = name.split('\\');
  const imported = scope.uses.class[first.toLowerCase()];
  if (imported) return rest.length ? `${imported}\\${rest.join('\\')}` : imported;
  return join(scope.namespace, name);
}

/** Noms complets candidats d'une fonction ou d'une constante, dans l'ordre de recherche de PHP. */
export function resolveFunctionOrConstant(name: string, kind: 'function' | 'constant', scope: NameScope): string[] {
  name = clean(name);
  if (name.startsWith('\\')) return [name.slice(1)];
  if (name.toLowerCase().startsWith('namespace\\')) return [join(scope.namespace, name.slice('namespace\\'.length))];
  if (name.includes('\\')) {
    const [first, ...rest] = name.split('\\');
    const imported = scope.uses.class[first.toLowerCase()];
    return [imported ? `${imported}\\${rest.join('\\')}` : join(scope.namespace, name)];
  }
  const imported = kind === 'function' ? scope.uses.function[name.toLowerCase()] : scope.uses.constant[name];
  if (imported) return [imported];
  return scope.namespace ? [join(scope.namespace, name), name] : [name];
}
