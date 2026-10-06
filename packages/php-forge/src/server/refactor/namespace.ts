// Renommer un namespace : sa déclaration et celles de ses sous-namespaces, les `use` et les noms qualifiés qui
// commencent par lui (segment entier), dans tous les fichiers qui utilisent son premier segment ; jamais dans les
// chaînes ni les commentaires.
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import type { Position } from '../../shared/types.ts';
import type { Node } from '../parser/parser.ts';
import { positionsOf, type RefEnv, type SourceFile } from './references.ts';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_NODES = new Set(['name', 'namespace_name', 'qualified_name']);

/** Namespace d'une déclaration `namespace A\B;` dont le nom est sous le curseur. */
export function namespaceAt(file: SourceFile, pos: Position): string | undefined {
  let node: Node | null = file.tree.rootNode.namedDescendantForPosition({ row: pos.line, column: pos.character });
  while (node && node.type !== 'namespace_definition' && NAME_NODES.has(node.type)) node = node.parent;
  if (node?.type !== 'namespace_definition') return undefined;
  return node.childForFieldName('name')?.text.replace(/\s+/g, '');
}

export function renameNamespace(env: RefEnv, from: string, to: string): WorkspaceEdit {
  const first = from.split('\\')[0].toLowerCase();
  const pattern = new RegExp(`(?<![\\w\\\\])(\\\\?)${escape(from)}(?=\\\\|;|\\s|\\{|$)`, 'gim');
  const changes: Record<string, TextEdit[]> = {};
  for (const symbols of env.files()) {
    if (symbols.uri.startsWith('phpstub:') || !symbols.names?.includes(first)) continue;
    const source = env.source(symbols.uri);
    if (!source) continue;
    try {
      const at = positionsOf(source.file.text);
      for (const match of source.file.text.matchAll(pattern)) {
        const index = match.index + match[1].length;
        const node = source.file.tree.rootNode.descendantForIndex(index);
        if (!node || !NAME_NODES.has(node.type)) continue;
        const start = at(index);
        (changes[symbols.uri] ??= []).push({ range: { start, end: { line: start.line, character: start.character + from.length } }, newText: to });
      }
    } finally {
      source.release();
    }
  }
  return { changes };
}
