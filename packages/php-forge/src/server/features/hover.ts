// Survol : type d'une variable ; pour une déclaration, signature (avec son namespace), versions de PHP,
// obsolescence et phpdoc (lien @link vers la documentation).
import * as l10n from '@vscode/l10n';
import type { Hover } from 'vscode-languageserver/node';
import type { FileSymbols, PhpSymbol, Position } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { Tree } from '../parser/parser.ts';
import { bindingAt, TypeResolver } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';
import { formatType } from '../types/type.ts';
import { variableAt } from './nameAt.ts';
import { resolveAt } from './resolve.ts';

export function hover(lookup: Lookup, file: FileSymbols, tree: Tree, pos: Position, resolver = new TypeResolver(lookup)): Hover | null {
  const variable = variableAt(tree, pos);
  if (variable) {
    const type = resolver.expand(new Inferrer(file.scopes).expr(variable), bindingAt(variable, file.scopes));
    return { contents: { kind: 'markdown', value: `\`\`\`php\n<?php\n${formatType(type)} ${variable.text}\n\`\`\`` } };
  }
  const hits = resolveAt(lookup, file, tree, pos, resolver);
  if (!hits.length) return null;
  return { contents: { kind: 'markdown', value: hoverMarkdown(hits[0].symbol, hits.length) } };
}

export function hoverMarkdown(symbol: PhpSymbol, count: number): string {
  const namespace = symbol.fqn?.includes('\\') ? `namespace ${symbol.fqn.slice(0, symbol.fqn.lastIndexOf('\\'))};\n` : '';
  const parts = [`\`\`\`php\n<?php\n${namespace}${symbol.signature ?? symbol.name}\n\`\`\``];
  const notes: string[] = [];
  if (symbol.deprecated) notes.push(l10n.t('**Deprecated**'));
  if (symbol.since) notes.push(l10n.t('Available since PHP {0}', symbol.since));
  if (symbol.until) notes.push(l10n.t('Available up to PHP {0}', symbol.until));
  if (symbol.removed) notes.push(l10n.t('Removed in PHP {0}', symbol.removed));
  if (count > 1) notes.push(l10n.t('{0} other declarations', count - 1));
  if (notes.length) parts.push(notes.join(' · '));
  if (symbol.doc) parts.push(formatDoc(symbol.doc));
  return parts.join('\n\n---\n\n');
}

/** Balises phpdoc en italique, une par ligne ; @link devient un lien. */
function formatDoc(doc: string): string {
  return doc
    .split('\n')
    .map((line) => {
      const link = /^@link\s+(\S+)/.exec(line);
      if (!link) return line.replace(/^(@\w+)/, '_$1_');
      let label = link[1];
      try {
        label = new URL(link[1]).host.replace(/^www\./, '');
      } catch {
        // pas une URL : texte brut
      }
      return `[${label}](${link[1]})`;
    })
    .join('  \n');
}
