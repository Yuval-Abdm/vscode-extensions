// Types PHP : constructeurs, union sans doublon, retrait de null, affichage lisible.
import type { PhpParam, ScalarName, TypeExpr, TypeRef } from '../../shared/types.ts';

export const MIXED: TypeExpr = { kind: 'mixed' };

export const scalar = (name: ScalarName): TypeExpr => ({ kind: 'scalar', name });

export const classType = (fqn: string, args?: TypeExpr[]): TypeExpr => (args?.length ? { kind: 'class', fqn, args } : { kind: 'class', fqn });

/** Au-delà de ce nombre de nœuds, un type devient mixed (types auto-référents qui doubleraient à chaque ligne). */
export const MAX_TYPE_SIZE = 200;

const SIZES = new WeakMap<TypeExpr, number>();

/** Nombre de nœuds d'un type, mémorisé par objet : linéaire même quand des sous-types sont partagés. */
export function sizeOf(type: TypeExpr): number {
  const known = SIZES.get(type);
  if (known !== undefined) return known;
  let size = 1;
  const add = (t: TypeExpr | undefined) => {
    if (t) size += sizeOf(t);
  };
  switch (type.kind) {
    case 'union':
    case 'intersection':
      type.types.forEach(add);
      break;
    case 'class':
      type.args?.forEach(add);
      break;
    case 'array':
      add(type.key);
      add(type.value);
      if (type.shape) Object.values(type.shape).forEach(add);
      break;
    case 'closure':
      add(type.returns);
      break;
    case 'ref': {
      const r = type.ref;
      if ('on' in r) add(r.on);
      if ('args' in r) r.args?.forEach(add);
      break;
    }
  }
  SIZES.set(type, size);
  return size;
}

export const ref = (r: TypeRef): TypeExpr => {
  const type: TypeExpr = { kind: 'ref', ref: r };
  return sizeOf(type) > MAX_TYPE_SIZE ? MIXED : type;
};

/** Membres d'une union, ou le type seul. */
export const members = (type: TypeExpr): TypeExpr[] => (type.kind === 'union' ? type.types : [type]);

export const isMixed = (type: TypeExpr | undefined): boolean => !type || type.kind === 'mixed';

const isNullType = (type: TypeExpr) => type.kind === 'scalar' && type.name === 'null';

/** Union aplatie et sans doublon ; `mixed` n'y figure que si rien d'autre n'est connu. */
export function union(...types: (TypeExpr | undefined)[]): TypeExpr {
  const out: TypeExpr[] = [];
  const seen = new Set<string>();
  const add = (type: TypeExpr): void => {
    if (type.kind === 'union') return type.types.forEach(add);
    if (type.kind === 'mixed') return;
    const key = JSON.stringify(type);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(type);
  };
  let size = 0;
  for (const type of types) {
    if (!type) continue;
    size += sizeOf(type);
    if (size > MAX_TYPE_SIZE) return MIXED;
    add(type);
  }
  if (!out.length) return MIXED;
  return out.length === 1 ? out[0] : { kind: 'union', types: out };
}

export function withoutNull(type: TypeExpr): TypeExpr {
  const rest = members(type).filter((t) => !isNullType(t));
  return rest.length ? union(...rest) : type;
}

const shortName = (fqn: string) => fqn.slice(fqn.lastIndexOf('\\') + 1);

/** Affichage : noms de classes courts, `?T` pour T|null, `T[]`, `array<K, V>`, `list<T>`, `array{…}`. */
export function formatType(type: TypeExpr): string {
  switch (type.kind) {
    case 'mixed':
    case 'ref':
      return 'mixed';
    case 'scalar':
      return type.name;
    case 'class':
      return type.args?.length ? `${shortName(type.fqn)}<${type.args.map(formatType).join(', ')}>` : shortName(type.fqn);
    case 'classString':
      return type.fqn ? `class-string<${shortName(type.fqn)}>` : type.template ? `class-string<${type.template}>` : 'class-string';
    case 'self':
    case 'static':
    case 'parent':
      return type.kind;
    case 'template':
      return type.name;
    case 'closure':
      return 'Closure';
    case 'intersection':
      return type.types.map(formatType).join('&');
    case 'union': {
      const rest = type.types.filter((t) => !isNullType(t));
      if (rest.length === 1 && rest.length < type.types.length) return `?${formatType(rest[0])}`;
      return type.types.map(formatType).join('|');
    }
    case 'array': {
      if (type.shape) return `array{${Object.entries(type.shape).map(([k, v]) => `${k}: ${formatType(v)}`).join(', ')}}`;
      if (!type.value) return 'array';
      if (type.list) return `list<${formatType(type.value)}>`;
      if (type.key) return `array<${formatType(type.key)}, ${formatType(type.value)}>`;
      const value = formatType(type.value);
      return type.value.kind === 'union' ? `(${value})[]` : `${value}[]`;
    }
  }
}

/** Paramètre lisible : « ?int &...$name = null ». */
export function formatParam(param: PhpParam, show: (type: TypeExpr) => string = formatType): string {
  const type = param.type ? `${show(param.type)} ` : '';
  const value = param.defaultValue !== undefined ? ` = ${param.defaultValue}` : '';
  return `${type}${param.byRef ? '&' : ''}${param.variadic ? '...' : ''}$${param.name}${value}`;
}
