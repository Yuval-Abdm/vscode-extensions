// Références dans les chaînes, seulement quand elles sont sûres : fonction passée par son nom à un paramètre
// `callable` connu (ou à function_exists), « Classe::methode », callables [$obj, 'm'], ['Classe', 'm'],
// [Classe::class, 'm'].
import type { Range } from '../../shared/types.ts';
import { resolveClassName, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node } from '../parser/parser.ts';
import { bindingAt } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';
import { members } from '../types/type.ts';
import type { RefEnv, SourceFile, Target } from './references.ts';

const NAME_CHECKS = new Set(['function_exists', 'is_callable']);

function literal(node: Node): string | undefined {
  if (node.type !== 'string' && node.type !== 'encapsed_string') return undefined;
  if (node.namedChildren.some((c) => c.type !== 'string_content')) return undefined;
  return node.text.slice(1, -1);
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.replace(/^\\/, '').toLowerCase() === b.replace(/^\\/, '').toLowerCase();

/** Plage du nom si l'occurrence à `index` est dans une chaîne qui désigne `target` de façon sûre. */
export function stringReference(env: RefEnv, file: SourceFile, target: Target, index: number): Range | undefined {
  const content = file.tree.rootNode.descendantForIndex(index);
  const string = content?.type === 'string_content' ? content.parent : content;
  if (!string) return undefined;
  const value = literal(string);
  if (value === undefined) return undefined;
  const start = rangeOf(string).start;
  const offset = index - string.startIndex;
  const range: Range = { start: { line: start.line, character: start.character + offset }, end: { line: start.line, character: start.character + offset + target.name.length } };
  if (target.kind === 'function') return functionString(env, string, value, target) ? range : undefined;
  if (target.kind === 'method') {
    const pair = /^\\?([\w\\]+)::(\w+)$/.exec(value);
    if (pair && same(pair[2], target.name)) {
      const scope = scopeAt(file.symbols.scopes, start);
      const fqn = resolveClassName(pair[1], scope);
      return fqn && ownsMember(env, fqn, target) ? range : undefined;
    }
    return arrayCallable(env, file, string, target) ? range : undefined;
  }
  return undefined;
}

/** `'f'` passé à un paramètre callable connu ou à function_exists / is_callable. */
function functionString(env: RefEnv, string: Node, value: string, target: Target): boolean {
  if (!same(value, target.name) && !target.declarations.some((d) => same(d.symbol.fqn, value))) return false;
  const argument = string.parent;
  const args = argument?.parent;
  const call = args?.parent;
  if (argument?.type !== 'argument' || call?.type !== 'function_call_expression') return false;
  const fn = call.childForFieldName('function')?.text.replace(/^\\/, '') ?? '';
  if (NAME_CHECKS.has(fn.toLowerCase())) return true;
  const index = args!.namedChildren.filter((a) => a.type === 'argument').findIndex((a) => a.id === argument.id);
  const params = env.lookup.findFunction(fn)[0]?.symbol.params ?? [];
  const param = params[index] ?? (params[params.length - 1]?.variadic ? params[params.length - 1] : undefined);
  return param?.type?.kind === 'scalar' && param.type.name === 'callable';
}

/** `[$obj, 'm']`, `['Classe', 'm']`, `[Classe::class, 'm']`. */
function arrayCallable(env: RefEnv, file: SourceFile, string: Node, target: Target): boolean {
  if (!same(literal(string), target.name)) return false;
  const element = string.parent;
  const array = element?.parent;
  if (element?.type !== 'array_element_initializer' || array?.type !== 'array_creation_expression') return false;
  const elements = array.namedChildren.filter((c) => c.type === 'array_element_initializer');
  if (elements.length !== 2 || elements[1].id !== element.id) return false;
  const first = elements[0].namedChildren[0];
  if (!first) return false;
  const scope = scopeAt(file.symbols.scopes, rangeOf(first).start);
  let classes: string[] = [];
  const name = literal(first);
  if (name) classes = [resolveClassName(name, scope) ?? ''];
  else if (first.type === 'class_constant_access_expression' && first.namedChildren[1]?.text.toLowerCase() === 'class') classes = [resolveClassName(first.namedChildren[0].text, scope) ?? ''];
  else {
    const type = env.resolver.expand(new Inferrer(file.symbols.scopes).expr(first), bindingAt(first, file.symbols.scopes));
    classes = members(type).flatMap((t) => (t.kind === 'class' ? [t.fqn] : []));
  }
  return classes.some((fqn) => fqn && ownsMember(env, fqn, target));
}

/** La méthode `target` est-elle celle trouvée sur la classe `fqn` ? */
function ownsMember(env: RefEnv, fqn: string, target: Target): boolean {
  return env.resolver.findMember({ fqn }, target.name, ['method']).some((hit) =>
    target.declarations.some((d) => d.uri === hit.owner.uri && d.symbol.selectionRange.start.line === hit.member.selectionRange.start.line));
}
