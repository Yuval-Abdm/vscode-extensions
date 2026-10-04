// Commentaires phpdoc : celui qui précède immédiatement une déclaration, nettoyé en texte.
import type { Node } from '../parser/parser.ts';

export function docComment(node: Node): string | undefined {
  const previous = node.previousNamedSibling;
  if (previous?.type !== 'comment' || !previous.text.startsWith('/**')) return undefined;
  if (previous.endPosition.row < node.startPosition.row - 1) return undefined;
  return cleanDoc(previous.text);
}

export function cleanDoc(raw: string): string {
  return raw
    .replace(/^\/\*\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*(?!\/) ?/, '').trimEnd())
    .join('\n')
    .trim();
}

/** Texte qui suit la balise `@tag` (première occurrence), ou undefined. */
export function docTag(doc: string | undefined, tag: string): string | undefined {
  return doc ? new RegExp(`^@${tag}\\b[ \\t]*(.*)$`, 'm').exec(doc)?.[1].trim() : undefined;
}
