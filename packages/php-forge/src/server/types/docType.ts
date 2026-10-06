// Types phpdoc → TypeExpr : unions, intersections, nullable, T[], génériques, formes array{…}, list<T>,
// class-string<T>, callable(…): T, littéraux, pseudo-types, templates. undefined si le texte n'est pas compris.
import type { NameScope, ScalarName, TypeExpr } from '../../shared/types.ts';
import { simpleType } from './declType.ts';
import { classType, MIXED, scalar, union } from './type.ts';

const TOKEN = /\s*(\.\.\.|\$this\b|[\\\w-]+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[|&?()<>,[\]{}:=])/y;
const ARRAYS = new Set(['array', 'non-empty-array', 'iterable', 'associative-array']);
const LISTS = new Set(['list', 'non-empty-list']);
const STRINGS = new Set([
  'non-empty-string', 'numeric-string', 'literal-string', 'lowercase-string', 'callable-string', 'trait-string',
  'interface-string', 'enum-string', 'truthy-string', 'non-falsy-string',
]);
const INTS = new Set(['positive-int', 'negative-int', 'non-positive-int', 'non-negative-int', 'non-zero-int']);
const UNKNOWN = new Set(['key-of', 'value-of', 'empty', 'int-mask', 'int-mask-of', 'properties-of', 'new']);

function tokenize(text: string): string[] | undefined {
  const tokens: string[] = [];
  const source = text.trim();
  let pos = 0;
  while (pos < source.length) {
    TOKEN.lastIndex = pos;
    const match = TOKEN.exec(source);
    if (!match) return undefined;
    tokens.push(match[1]);
    pos = TOKEN.lastIndex;
  }
  return tokens;
}

class DocTypeParser {
  #i = 0;
  readonly #tokens: string[];
  readonly #scope: NameScope;
  readonly #templates: string[];

  constructor(tokens: string[], scope: NameScope, templates: string[]) {
    this.#tokens = tokens;
    this.#scope = scope;
    this.#templates = templates;
  }

  done(): boolean {
    return this.#i === this.#tokens.length;
  }

  #peek(offset = 0): string | undefined {
    return this.#tokens[this.#i + offset];
  }

  #next(): string {
    const token = this.#tokens[this.#i++];
    if (token === undefined) throw new Error('unexpected end of type');
    return token;
  }

  #eat(expected: string): void {
    if (this.#next() !== expected) throw new Error(`expected ${expected}`);
  }

  union(): TypeExpr {
    const parts = [this.#intersection()];
    while (this.#peek() === '|') {
      this.#next();
      parts.push(this.#intersection());
    }
    return parts.length === 1 ? parts[0] : union(...parts);
  }

  #intersection(): TypeExpr {
    const parts = [this.#postfix()];
    while (this.#peek() === '&') {
      this.#next();
      parts.push(this.#postfix());
    }
    return parts.length === 1 ? parts[0] : { kind: 'intersection', types: parts };
  }

  #postfix(): TypeExpr {
    let type = this.#atom();
    while (this.#peek() === '[' && this.#peek(1) === ']') {
      this.#i += 2;
      type = { kind: 'array', value: type };
    }
    return type;
  }

  #generics(): TypeExpr[] {
    if (this.#peek() !== '<') return [];
    this.#next();
    const args = [this.union()];
    while (this.#peek() === ',') {
      this.#next();
      args.push(this.union());
    }
    this.#eat('>');
    return args;
  }

  #atom(): TypeExpr {
    const token = this.#next();
    if (token === '?') return union(this.#atom(), scalar('null'));
    if (token === '(') {
      const inner = this.union();
      this.#eat(')');
      return inner;
    }
    if (token.startsWith("'") || token.startsWith('"')) return scalar('string');
    if (/^-?\d/.test(token)) return scalar(token.includes('.') ? 'float' : 'int');
    if (!/^[\\\w$]/.test(token)) throw new Error(`unexpected ${token}`);
    const lower = token.toLowerCase();
    if (this.#peek() === '{' && (ARRAYS.has(lower) || LISTS.has(lower) || lower === 'object')) return this.#shape(lower);
    if (this.#peek() === '(' && (lower === 'callable' || lower === 'closure' || lower === '\\closure')) return this.#callable(lower !== 'callable');
    const args = this.#generics();
    if (this.#templates.includes(token)) return { kind: 'template', name: token };
    if (lower === 'iterable' && !args.length) return scalar('iterable');
    if (ARRAYS.has(lower)) {
      if (args.length >= 2) return { kind: 'array', key: args[0], value: args[1] };
      return args.length ? { kind: 'array', value: args[0] } : { kind: 'array' };
    }
    if (LISTS.has(lower)) return args.length ? { kind: 'array', list: true, value: args[0] } : { kind: 'array', list: true };
    if (lower === 'class-string') {
      const target = args[0];
      if (target?.kind === 'class') return { kind: 'classString', fqn: target.fqn };
      if (target?.kind === 'template') return { kind: 'classString', template: target.name };
      return { kind: 'classString' };
    }
    if (STRINGS.has(lower)) return scalar('string');
    if (INTS.has(lower)) return scalar('int');
    if (lower === 'array-key' || lower === 'scalar' || lower === 'numeric') return scalar(lower as ScalarName);
    if (UNKNOWN.has(lower)) return MIXED;
    const simple = simpleType(token, this.#scope);
    if (!simple) return MIXED;
    return simple.kind === 'class' && args.length ? classType(simple.fqn, args) : simple;
  }

  #shape(lower: string): TypeExpr {
    this.#eat('{');
    const shape: Record<string, TypeExpr> = {};
    let index = 0;
    while (this.#peek() !== '}') {
      let key: string | undefined;
      if (this.#peek(1) === ':' || (this.#peek(1) === '?' && this.#peek(2) === ':')) {
        key = this.#next().replace(/^['"]|['"]$/g, '');
        if (this.#peek() === '?') this.#next();
        this.#eat(':');
      }
      shape[key ?? String(index++)] = this.union();
      if (this.#peek() !== ',') break;
      this.#next();
    }
    this.#eat('}');
    if (lower === 'object') return classType('stdClass');
    if (LISTS.has(lower)) return { kind: 'array', list: true, value: union(...Object.values(shape)) };
    return { kind: 'array', shape };
  }

  #callable(closure: boolean): TypeExpr {
    this.#eat('(');
    for (let depth = 1; depth > 0; ) {
      const token = this.#next();
      if (token === '(') depth++;
      else if (token === ')') depth--;
    }
    let returns: TypeExpr | undefined;
    if (this.#peek() === ':') {
      this.#next();
      returns = this.#postfix();
    }
    if (!closure) return scalar('callable');
    return returns ? { kind: 'closure', returns } : { kind: 'closure' };
  }
}

export function parseDocType(text: string, scope: NameScope, templates: string[] = []): TypeExpr | undefined {
  const tokens = tokenize(text);
  if (!tokens?.length) return undefined;
  try {
    const parser = new DocTypeParser(tokens, scope, templates);
    const type = parser.union();
    return parser.done() ? type : undefined;
  } catch {
    return undefined;
  }
}
