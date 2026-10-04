// Résolution des types différés avec l'index : retours de fonctions et de méthodes, propriétés, constantes,
// éléments et clés de tableaux ou d'itérables, self / static / parent, templates (@template, @extends Parent<T>).
// Profondeur bornée : un type récursif ou cyclique devient mixed.
import type { NameScope, PhpSymbol, SymbolKind, TypeExpr, TypeRef } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { enclosingClass } from '../model/context.ts';
import type { Node } from '../parser/parser.ts';
import { isAvailable } from '../stubs/availability.ts';
import { classType, members, MIXED, scalar, union } from './type.ts';

export interface Binding {
  /** Classe qui déclare le membre (self) */
  self?: string;
  /** Classe de l'objet (static, $this) */
  static?: string;
  templates?: Map<string, TypeExpr>;
}

export interface MemberHit {
  owner: IndexedSymbol;
  member: PhpSymbol;
  binding: Binding;
}

export interface Receiver {
  fqn: string;
  args?: TypeExpr[];
}

const MAX_DEPTH = 12;
const sameMember = (kind: SymbolKind, a: string, b: string) => (kind === 'method' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** self / static d'un nœud : sa classe englobante. */
export function bindingAt(node: Node, scopes: NameScope[]): Binding {
  const self = enclosingClass(node, scopes);
  return self ? { self, static: self } : {};
}

export class TypeResolver {
  readonly lookup: Lookup;
  phpVersion: string | undefined;

  constructor(lookup: Lookup, phpVersion?: string) {
    this.lookup = lookup;
    this.phpVersion = phpVersion;
  }

  /** Type d'une déclaration : déclaré, sinon déduit du code. */
  returnOf(symbol: PhpSymbol): TypeExpr {
    return symbol.type ?? symbol.inferred ?? MIXED;
  }

  /** Déclaration disponible pour la version de PHP (variantes des stubs), sinon la première. */
  pick(hits: IndexedSymbol[]): IndexedSymbol | undefined {
    return hits.find((h) => isAvailable(h.symbol, this.phpVersion)) ?? hits[0];
  }

  parentOf(fqn: string): string | undefined {
    return this.lookup.findClass(fqn)[0]?.symbol.extends?.[0];
  }

  expand(type: TypeExpr, binding: Binding = {}, depth = 0): TypeExpr {
    if (depth > MAX_DEPTH) return MIXED;
    const next = (t: TypeExpr) => this.expand(t, binding, depth + 1);
    switch (type.kind) {
      case 'mixed':
      case 'scalar':
        return type;
      case 'classString': {
        if (!type.template) return type;
        const bound = binding.templates?.get(type.template);
        return bound?.kind === 'class' ? { kind: 'classString', fqn: bound.fqn } : { kind: 'classString' };
      }
      case 'class':
        return type.args ? classType(type.fqn, type.args.map(next)) : type;
      case 'self':
        return binding.self ? classType(binding.self) : MIXED;
      case 'static': {
        const fqn = binding.static ?? binding.self;
        return fqn ? classType(fqn) : MIXED;
      }
      case 'parent': {
        const parent = binding.self && this.parentOf(binding.self);
        return parent ? classType(parent) : MIXED;
      }
      case 'template':
        return binding.templates?.get(type.name) ?? MIXED;
      case 'closure':
        return type.returns ? { kind: 'closure', returns: next(type.returns) } : type;
      case 'array': {
        const out: Extract<TypeExpr, { kind: 'array' }> = { kind: 'array' };
        if (type.list) out.list = true;
        if (type.key) out.key = next(type.key);
        if (type.value) out.value = next(type.value);
        if (type.shape) out.shape = Object.fromEntries(Object.entries(type.shape).map(([k, v]) => [k, next(v)]));
        return out;
      }
      case 'union':
        return union(...type.types.map(next));
      case 'intersection':
        return { kind: 'intersection', types: type.types.map(next) };
      case 'ref':
        return this.#ref(type.ref, binding, depth + 1);
    }
  }

  #ref(r: TypeRef, binding: Binding, depth: number): TypeExpr {
    switch (r.of) {
      case 'function': {
        const args = (r.args ?? []).map((a) => this.expand(a, binding, depth));
        for (const name of r.names) {
          const hit = this.pick(this.lookup.findFunction(name));
          if (hit) return this.expand(this.returnOf(hit.symbol), { templates: this.bindTemplates(hit.symbol, args) }, depth);
        }
        return MIXED;
      }
      case 'constant': {
        for (const name of r.names) {
          const hit = this.pick(this.lookup.findConstant(name));
          if (hit) return this.expand(this.returnOf(hit.symbol), {}, depth);
        }
        return MIXED;
      }
      case 'method':
      case 'property':
      case 'classConstant': {
        const on = this.expand(r.on, binding, depth);
        const kinds: SymbolKind[] = r.of === 'method' ? ['method'] : r.of === 'property' ? ['property'] : ['classConstant', 'enumCase'];
        const args = r.of === 'method' ? (r.args ?? []).map((a) => this.expand(a, binding, depth)) : [];
        const out: TypeExpr[] = [];
        for (const receiver of members(on)) {
          if (receiver.kind !== 'class') continue;
          const hit = this.findMember(receiver, r.name, kinds)[0];
          if (!hit) continue;
          if (hit.member.kind === 'enumCase') {
            out.push(classType(hit.owner.symbol.fqn ?? receiver.fqn));
            continue;
          }
          let memberBinding = hit.binding;
          if (hit.member.templates?.length) {
            memberBinding = { ...hit.binding, templates: new Map([...(hit.binding.templates ?? []), ...this.bindTemplates(hit.member, args)]) };
          }
          out.push(this.expand(this.returnOf(hit.member), memberBinding, depth));
        }
        return union(...out);
      }
      case 'element':
        return union(...members(this.expand(r.on, binding, depth)).map(elementOf));
      case 'key':
        return union(...members(this.expand(r.on, binding, depth)).map(keyOf));
      case 'offset':
        return union(...members(this.expand(r.on, binding, depth)).map((t) => offsetOf(t, r.key)));
    }
  }

  /** La classe et ses ancêtres (parents, traits, interfaces, mixins), avec les génériques propagés. */
  *hierarchy(fqn: string, args: TypeExpr[] = []): Generator<{ hit: IndexedSymbol; templates: Map<string, TypeExpr> }> {
    const queue: Receiver[] = [{ fqn, args }];
    const seen = new Set<string>();
    while (queue.length) {
      const item = queue.shift()!;
      const key = item.fqn.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const hit of this.lookup.findClass(item.fqn)) {
        const templates = new Map<string, TypeExpr>();
        hit.symbol.templates?.forEach((name, i) => {
          const arg = item.args?.[i];
          if (arg) templates.set(name, arg);
        });
        yield { hit, templates };
        const parents = [...(hit.symbol.extends ?? []), ...(hit.symbol.uses ?? []), ...(hit.symbol.implements ?? []), ...(hit.symbol.mixins ?? [])];
        for (const parent of parents) {
          const parentArgs = (hit.symbol.parentArgs?.[parent.toLowerCase()] ?? []).map((a) => this.expand(a, { templates }));
          queue.push({ fqn: parent, args: parentArgs });
        }
      }
    }
  }

  /** Membres `name` de la classe la plus proche qui en déclare (une redéfinition masque l'original). */
  findMember(receiver: Receiver, name: string, kinds: SymbolKind[]): MemberHit[] {
    const out: MemberHit[] = [];
    for (const { hit, templates } of this.hierarchy(receiver.fqn, receiver.args)) {
      for (const member of hit.symbol.children ?? []) {
        if (!kinds.includes(member.kind) || !sameMember(member.kind, member.name, name)) continue;
        out.push({ owner: hit, member, binding: { self: hit.symbol.fqn, static: receiver.fqn, templates } });
      }
      if (out.length) return out;
    }
    return out;
  }

  /** Tous les membres d'un type (complétion) ; pour un même nom, la déclaration la plus proche. */
  membersOf(receiver: Receiver, kinds: SymbolKind[]): MemberHit[] {
    const out: MemberHit[] = [];
    const seen = new Set<string>();
    for (const { hit, templates } of this.hierarchy(receiver.fqn, receiver.args)) {
      for (const member of hit.symbol.children ?? []) {
        if (!kinds.includes(member.kind)) continue;
        const key = `${member.kind}:${member.kind === 'method' ? member.name.toLowerCase() : member.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ owner: hit, member, binding: { self: hit.symbol.fqn, static: receiver.fqn, templates } });
      }
    }
    return out;
  }

  /** Templates d'une fonction ou méthode liés par les types des arguments (T, class-string<T>, T[]). */
  bindTemplates(symbol: PhpSymbol, args: TypeExpr[]): Map<string, TypeExpr> {
    const out = new Map<string, TypeExpr>();
    if (!symbol.templates?.length) return out;
    symbol.params?.forEach((param, i) => {
      const arg = args[i];
      const type = param.type;
      if (!arg || !type) return;
      if (type.kind === 'template') out.set(type.name, arg);
      else if (type.kind === 'classString' && type.template && arg.kind === 'classString' && arg.fqn) out.set(type.template, classType(arg.fqn));
      else if (type.kind === 'array' && type.value?.kind === 'template' && arg.kind === 'array' && arg.value) out.set(type.value.name, arg.value);
    });
    return out;
  }
}

function elementOf(type: TypeExpr): TypeExpr {
  if (type.kind === 'array') return type.value ?? (type.shape ? union(...Object.values(type.shape)) : MIXED);
  if (type.kind === 'class' && type.args?.length) return type.args[type.args.length - 1];
  if (type.kind === 'scalar' && type.name === 'string') return type;
  return MIXED;
}

function keyOf(type: TypeExpr): TypeExpr {
  if (type.kind === 'array') {
    if (type.key) return type.key;
    if (type.list) return scalar('int');
    if (type.shape) return union(...Object.keys(type.shape).map((k) => scalar(/^-?\d+$/.test(k) ? 'int' : 'string')));
    return union(scalar('int'), scalar('string'));
  }
  if (type.kind === 'class' && (type.args?.length ?? 0) >= 2) return type.args![0];
  return MIXED;
}

function offsetOf(type: TypeExpr, key: string | undefined): TypeExpr {
  if (type.kind === 'array' && type.shape && key !== undefined && Object.hasOwn(type.shape, key)) return type.shape[key];
  return elementOf(type);
}
