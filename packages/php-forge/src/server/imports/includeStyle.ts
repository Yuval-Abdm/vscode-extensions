// « Add include » : instruction écrite dans le style dominant du fichier — constante de chemin (ROOT_PATH.'/…'),
// __DIR__ . '/…', $_SERVER['DOCUMENT_ROOT'] . '/…', chemin relatif — avec le même mot-clé, les mêmes guillemets
// et espaces que son premier include ; à défaut require_once __DIR__ . '/…'.
import path from 'node:path';
import type { TextEdit } from 'vscode-languageserver/node';
import type { FileSymbols, IncludeRef, PathExpr } from '../../shared/types.ts';
import type { IncludeGraph } from '../includes/graph.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Tree } from '../parser/parser.ts';

type Style = { kind: 'const'; name: string; base: string } | { kind: 'dir' } | { kind: 'docroot' } | { kind: 'relative' };

const posix = (p: string) => p.split(path.sep).join('/');

function styleOf(ref: IncludeRef, graph: IncludeGraph | undefined): Style | undefined {
  const head: PathExpr = ref.path.k === 'cat' ? ref.path.parts[0] : ref.path;
  if (head.k === 'const') {
    const base = graph?.constant(head.name);
    return base ? { kind: 'const', name: head.name, base } : undefined;
  }
  if (head.k === 'dir' || (head.k === 'dirname' && head.of.k === 'file' && head.levels === 1)) return { kind: 'dir' };
  if (head.k === 'docroot') return { kind: 'docroot' };
  if (ref.path.k === 'lit') return { kind: 'relative' };
  return undefined;
}

export function includeStatement(file: { fsPath: string; text: string; symbols: FileSymbols }, target: string, graph: IncludeGraph | undefined): string {
  const dir = path.dirname(file.fsPath);
  const counts = new Map<string, { style: Style; ref: IncludeRef; n: number }>();
  for (const ref of file.symbols.includes) {
    const style = styleOf(ref, graph);
    if (!style) continue;
    const key = style.kind === 'const' ? `const:${style.name}` : style.kind;
    const entry = counts.get(key) ?? { style, ref, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  const dominant = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!dominant) return `require_once __DIR__ . '/${posix(path.relative(dir, target))}';`;
  // Forme du premier include de ce style : mot-clé, parenthèses, guillemets, espaces autour du point
  const source = file.text.slice(offsetOf(file.text, dominant.ref.range.start), offsetOf(file.text, dominant.ref.range.end));
  const keyword = dominant.ref.kind;
  const paren = new RegExp(`^${keyword}\\s*\\(`).test(source);
  const quote = /"/.test(source) && !/'/.test(source.replace(/\$_SERVER\['DOCUMENT_ROOT'\]/, '')) ? '"' : "'";
  const dot = /\s\.\s/.test(source) ? ' . ' : '.';
  let expression: string;
  switch (dominant.style.kind) {
    case 'const':
      expression = `${dominant.style.name}${dot}${quote}/${posix(path.relative(dominant.style.base, target))}${quote}`;
      break;
    case 'dir':
      expression = `__DIR__${dot}${quote}/${posix(path.relative(dir, target))}${quote}`;
      break;
    case 'docroot':
      expression = `$_SERVER['DOCUMENT_ROOT']${dot}${quote}/${posix(path.relative(graph?.docroot ?? dir, target))}${quote}`;
      break;
    case 'relative':
      expression = `${quote}${posix(path.relative(dir, target))}${quote}`;
      break;
  }
  return paren ? `${keyword}(${expression});` : `${keyword} ${expression};`;
}

function offsetOf(text: string, pos: { line: number; character: number }): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) offset = text.indexOf('\n', offset) + 1;
  return offset + pos.character;
}

/** Insertion après le dernier include du niveau fichier, sinon après <?php. */
export function includeEdit(tree: Tree, statement: string): TextEdit {
  const includes = tree.rootNode.namedChildren.filter((c) => c.type === 'expression_statement' && /^(include|require)/.test(c.namedChildren[0]?.type ?? ''));
  const tag = tree.rootNode.namedChildren.find((c) => c.type === 'php_tag');
  const line = includes.length ? rangeOf(includes[includes.length - 1]).end.line + 1 : (tag ? rangeOf(tag).end.line + 1 : 0);
  return { range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: `${statement}\n` };
}
