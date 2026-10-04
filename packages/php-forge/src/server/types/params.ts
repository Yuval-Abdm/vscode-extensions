// Paramètres d'une fonction ou méthode : types déclarés complétés par @param et par les attributs des stubs.
import type { NameScope, PhpParam, TypeExpr } from '../../shared/types.ts';
import { docComment, docParams } from '../model/phpdoc.ts';
import { squash, truncate } from '../model/signature.ts';
import type { Node } from '../parser/parser.ts';
import { typeFromNode } from './declType.ts';
import { parseDocType } from './docType.ts';
import { members } from './type.ts';

const PARAMETERS = new Set(['simple_parameter', 'variadic_parameter', 'property_promotion_parameter']);

/** Type trop vague pour être préféré à la phpdoc : array sans contenu, mixed, iterable, object, classe sans générique… */
function isVague(type: TypeExpr): boolean {
  switch (type.kind) {
    case 'mixed':
      return true;
    case 'array':
      return !type.value && !type.shape;
    case 'scalar':
      return ['iterable', 'object', 'callable', 'null', 'array-key'].includes(type.name);
    case 'class':
      return !type.args;
    default:
      return false;
  }
}

/** Type déclaré ou phpdoc : la phpdoc l'emporte quand elle est comprise et le type déclaré vague. */
export function pickType(declared: TypeExpr | undefined, documented: TypeExpr | undefined): TypeExpr | undefined {
  if (!documented || documented.kind === 'mixed') return declared ?? documented;
  if (!declared || documented.kind === 'classString') return documented;
  return members(declared).every(isVague) ? documented : declared;
}

/** Type d'un attribut LanguageLevelTypeAware (stubs) : celui de la version de PHP la plus récente. */
export function levelTypeAware(node: Node, scope: NameScope, templates: string[]): TypeExpr | undefined {
  const attributes = node.namedChildren.filter((c) => c.type === 'attribute_list').map((c) => c.text).join(' ');
  const map = /LanguageLevelTypeAware\s*\(\s*\[([^\]]*)\]/.exec(attributes)?.[1];
  if (!map) return undefined;
  const types = [...map.matchAll(/=>\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return types.length ? parseDocType(types[types.length - 1], scope, templates) : undefined;
}

export function parametersOf(fn: Node, scope: NameScope, templates: string[], doc = docComment(fn)): PhpParam[] {
  const docs = docParams(doc);
  const out: PhpParam[] = [];
  for (const node of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    if (!PARAMETERS.has(node.type)) continue;
    const variable = node.childForFieldName('name');
    if (!variable) continue;
    const name = variable.text.replace(/^\$/, '');
    const documented = docs.get(name);
    const param: PhpParam = { name };
    const declared = typeFromNode(node.childForFieldName('type'), scope) ?? levelTypeAware(node, scope, templates);
    const type = pickType(declared, documented?.type ? parseDocType(documented.type, scope, templates) : undefined);
    if (type) param.type = type;
    const value = node.childForFieldName('default_value');
    if (value) param.defaultValue = truncate(squash(value.text), 40);
    if (node.type === 'variadic_parameter') param.variadic = true;
    if (node.childForFieldName('reference_modifier') || node.children.some((c) => c.type === 'reference_modifier')) param.byRef = true;
    if (documented?.description) param.doc = documented.description;
    out.push(param);
  }
  return out;
}
