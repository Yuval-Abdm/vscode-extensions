// Aide aux paramètres : signature de l'appel en cours, paramètre actif (position ou argument nommé),
// documentation de la fonction et des paramètres. Code incomplet (parenthèse non fermée) : le document est
// ré-analysé (de façon incrémentale) avec une parenthèse fermante au curseur.
import type { ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import type { Position, TypeExpr } from '../../shared/types.ts';
import type { OpenDocument } from '../documents.ts';
import { docSummary } from '../model/phpdoc.ts';
import { parseWithInsertion } from '../parser/insert.ts';
import type { Parser, Tree } from '../parser/parser.ts';
import type { TypeResolver } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';
import { formatParam, formatType } from '../types/type.ts';
import { callAt, callTarget } from './calls.ts';

export function signatureHelp(env: { resolver: TypeResolver; parser: Parser }, doc: OpenDocument, position: Position): SignatureHelp | null {
  const offset = doc.doc.offsetAt(position);
  const result = helpAt(env.resolver, doc, doc.tree, offset);
  if (result !== undefined) return result;
  const patched = parseWithInsertion(env.parser, doc.doc.getText(), offset, ')', '', { tree: doc.tree, position });
  try {
    return helpAt(env.resolver, doc, patched, offset) ?? null;
  } finally {
    patched.delete();
  }
}

/** undefined : aucun appel trouvé dans cet arbre ; null : appel trouvé mais déclaration inconnue. */
function helpAt(resolver: TypeResolver, doc: OpenDocument, tree: Tree, offset: number): SignatureHelp | null | undefined {
  const site = callAt(tree, offset);
  if (!site) return undefined;
  const target = callTarget(site.call, doc.symbols, resolver, new Inferrer(doc.symbols.scopes));
  if (!target) return null;
  const { symbol, binding } = target;
  const params = symbol.params ?? [];
  const show = (type: TypeExpr) => formatType(resolver.expand(type, binding));
  const name = target.owner ? target.owner.slice(target.owner.lastIndexOf('\\') + 1) : symbol.name;
  let label = `${name}(`;
  const parameters: ParameterInformation[] = [];
  params.forEach((param, i) => {
    if (i) label += ', ';
    const text = formatParam(param, show);
    const info: ParameterInformation = { label: [label.length, label.length + text.length] };
    if (param.doc) info.documentation = param.doc;
    parameters.push(info);
    label += text;
  });
  label += ')';
  const returns = symbol.type ?? symbol.inferred;
  if (returns && !target.owner) label += `: ${show(returns)}`;

  let active = site.named ? params.findIndex((p) => p.name === site.named) : site.active;
  if (active < 0) active = site.active;
  const variadic = params.findIndex((p) => p.variadic);
  if (variadic >= 0 && active > variadic) active = variadic;

  const signature: SignatureInformation = { label, parameters, activeParameter: active };
  const summary = docSummary(symbol.doc);
  if (summary) signature.documentation = { kind: 'markdown', value: summary };
  return { signatures: [signature], activeSignature: 0, activeParameter: active };
}
