// Fonctionnalités SQL au format LSP, dans les requêtes d'un document ouvert : complétion (tables, colonnes selon les
// alias, fonctions), survol (type, NULL, défaut) et définition (CREATE TABLE d'un fichier .sql).
import { CompletionItemKind, MarkupKind, type CompletionItem, type CompletionList, type Hover, type Location, type Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Tree } from '../parser/parser.ts';
import { sqlAt, sqlCompletion, sqlHover, sqlTarget, type SqlTarget } from './features.ts';
import type { Schema } from './schema.ts';

const KINDS = { table: CompletionItemKind.Struct, column: CompletionItemKind.Field, function: CompletionItemKind.Function } as const;

/** Complétion dans une requête ; undefined : le curseur n'est pas dans du SQL (complétion PHP). */
export function sqlCompletionList(tree: Tree, doc: TextDocument, position: Position, schema: Schema): CompletionList | undefined {
  const site = sqlAt(tree, doc.offsetAt(position));
  if (!site) return undefined;
  const result = sqlCompletion(site, schema);
  if (!result) return { isIncomplete: false, items: [] };
  const range = { start: doc.positionAt(result.from), end: position };
  const items: CompletionItem[] = result.items.map((item, i) => ({
    label: item.label,
    kind: KINDS[item.kind],
    detail: item.detail,
    // Tables et colonnes avant les fonctions, dans l'ordre du schéma
    sortText: `${item.kind === 'function' ? 1 : 0}${String(i).padStart(5, '0')}`,
    textEdit: { range, newText: item.label },
  }));
  return { isIncomplete: false, items };
}

function targetAt(tree: Tree, doc: TextDocument, position: Position, schema: Schema): SqlTarget | undefined {
  const site = sqlAt(tree, doc.offsetAt(position));
  return site && sqlTarget(site, schema);
}

export function sqlHoverAt(tree: Tree, doc: TextDocument, position: Position, schema: Schema): Hover | undefined {
  const target = targetAt(tree, doc, position, schema);
  return target && { contents: { kind: MarkupKind.Markdown, value: sqlHover(target) } };
}

/** Table (ou colonne : sa table) déclarée dans un fichier .sql du projet ; le cache de la base n'a pas de position. */
export function sqlDefinitionAt(tree: Tree, doc: TextDocument, position: Position, schema: Schema): Location[] | undefined {
  const table = targetAt(tree, doc, position, schema)?.table;
  if (!table?.uri || !table.uri.toLowerCase().endsWith('.sql') || table.line === undefined) return undefined;
  const start = { line: table.line, character: table.character ?? 0 };
  return [{ uri: table.uri, range: { start, end: { line: start.line, character: start.character + table.name.length } } }];
}
