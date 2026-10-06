// Commentaires phpdoc : celui qui précède une déclaration, nettoyé ; balises (@param, @return, @var, @template…).
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

export interface DocTag {
  /** Nom en minuscules, sans « @ » */
  name: string;
  /** Texte de la balise, lignes de continuation comprises */
  text: string;
}

export function docTags(doc: string | undefined): DocTag[] {
  const out: DocTag[] = [];
  for (const line of (doc ?? '').split('\n')) {
    const match = /^@([\w-]+)\s*(.*)$/.exec(line);
    if (match) out.push({ name: match[1].toLowerCase(), text: match[2] });
    else if (out.length && line.trim()) out[out.length - 1].text += `\n${line}`;
  }
  return out;
}

/** Texte sans balises HTML (stubs PHP), espaces réduits. */
export function plainText(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Description qui précède la première balise. */
export function docSummary(doc: string | undefined): string | undefined {
  const lines: string[] = [];
  for (const line of (doc ?? '').split('\n')) {
    if (line.startsWith('@')) break;
    lines.push(line);
  }
  return lines.join('\n').trim() || undefined;
}

/** Sépare « Type reste » : le type peut contenir des espaces entre < >, ( ), { }, [ ] et autour de « | », « & », « : ». */
export function splitType(text: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('<({['.includes(c)) depth++;
    else if ('>)}]'.includes(c)) depth--;
    else if (/\s/.test(c) && depth <= 0) {
      const before = text.slice(0, i).trimEnd();
      const after = text.slice(i).trimStart();
      if (/[:|&,]$/.test(before) || /^[|&]/.test(after)) continue;
      return [text.slice(0, i), after];
    }
  }
  return [text, ''];
}

/** Découpe une liste au premier niveau de parenthèses : « int $a, array $b = [1, 2] ». */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('<({['.includes(c)) depth++;
    else if ('>)}]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export interface DocParam {
  type?: string;
  description?: string;
}

/** @param Type $name description ; les variantes @phpstan-param / @psalm-param l'emportent sur le type. */
export function docParams(doc: string | undefined): Map<string, DocParam> {
  const out = new Map<string, DocParam>();
  const precise = new Set<string>();
  for (const tag of docTags(doc)) {
    const match = /^(phpstan-|psalm-)?param$/.exec(tag.name);
    if (!match) continue;
    let rest = tag.text.trim();
    let type: string | undefined;
    if (!/^(&\s*)?(\.\.\.)?\$/.test(rest)) [type, rest] = splitType(rest);
    const variable = /^&?\s*(?:\.\.\.)?\$(\w+)([\s\S]*)$/.exec(rest);
    if (!variable) continue;
    const name = variable[1];
    const entry: DocParam = {};
    if (type) entry.type = type;
    const description = plainText(variable[2]);
    if (description) entry.description = description;
    const old = out.get(name);
    if (match[1]) {
      precise.add(name);
      const merged: DocParam = { ...old };
      if (entry.type) merged.type = entry.type;
      if (entry.description) merged.description = entry.description;
      out.set(name, merged);
    } else if (precise.has(name)) {
      if (old && !old.description && entry.description) old.description = entry.description;
    } else {
      out.set(name, entry);
    }
  }
  return out;
}

export function docReturn(doc: string | undefined): string | undefined {
  let plain: string | undefined;
  for (const tag of docTags(doc)) {
    if (tag.name === 'phpstan-return' || tag.name === 'psalm-return') return splitType(tag.text.trim())[0] || undefined;
    if (tag.name === 'return' && plain === undefined) plain = splitType(tag.text.trim())[0];
  }
  return plain || undefined;
}

/** @var Type [$name] (et l'ordre inverse « @var $name Type »). */
export function docVar(doc: string | undefined): { type: string; name?: string }[] {
  const out: { type: string; name?: string }[] = [];
  for (const tag of docTags(doc)) {
    if (!/^(phpstan-|psalm-)?var$/.test(tag.name)) continue;
    const [type, rest] = splitType(tag.text.trim());
    if (!type) continue;
    if (type.startsWith('$')) {
      const [actual] = splitType(rest);
      if (actual) out.push({ type: actual, name: type.slice(1) });
      continue;
    }
    const name = /^\$(\w+)/.exec(rest)?.[1];
    out.push(name ? { type, name } : { type });
  }
  return out;
}

export function docTemplates(doc: string | undefined): string[] {
  return docTags(doc)
    .filter((tag) => /^(phpstan-|psalm-)?template(-covariant|-contravariant)?$/.test(tag.name))
    .map((tag) => /^(\w+)/.exec(tag.text.trim())?.[1])
    .filter((name): name is string => !!name);
}

/** Types des @extends / @implements / @use (et variantes phpstan, psalm, template-). */
export function docParents(doc: string | undefined): string[] {
  return docTags(doc)
    .filter((tag) => /^(phpstan-|psalm-|template-)?(extends|implements|use)$/.test(tag.name))
    .map((tag) => splitType(tag.text.trim())[0])
    .filter(Boolean);
}

export function docMixins(doc: string | undefined): string[] {
  return docTags(doc)
    .filter((tag) => tag.name === 'mixin')
    .map((tag) => splitType(tag.text.trim())[0])
    .filter(Boolean);
}

export interface DocProperty {
  name: string;
  type?: string;
  description?: string;
}

export function docProperties(doc: string | undefined): DocProperty[] {
  const out: DocProperty[] = [];
  for (const tag of docTags(doc)) {
    if (!/^(phpstan-|psalm-)?property(-read|-write)?$/.test(tag.name)) continue;
    let rest = tag.text.trim();
    let type: string | undefined;
    if (!rest.startsWith('$')) [type, rest] = splitType(rest);
    const variable = /^\$(\w+)([\s\S]*)$/.exec(rest);
    if (!variable) continue;
    const entry: DocProperty = { name: variable[1] };
    if (type) entry.type = type;
    const description = plainText(variable[2]);
    if (description) entry.description = description;
    out.push(entry);
  }
  return out;
}

export interface DocMethod {
  name: string;
  returns?: string;
  isStatic: boolean;
  params: string[];
  description?: string;
}

/** @method [static] [Type] name(params) description */
export function docMethods(doc: string | undefined): DocMethod[] {
  const out: DocMethod[] = [];
  for (const tag of docTags(doc)) {
    if (!/^(phpstan-|psalm-)?method$/.test(tag.name)) continue;
    let text = tag.text.split('\n')[0].trim();
    let isStatic = false;
    if (/^static\s+\S+\s*\S*\(/.test(text) && !/^static\s*\(/.test(text)) {
      isStatic = true;
      text = text.slice('static'.length).trim();
    }
    const open = text.indexOf('(');
    if (open < 0) continue;
    let close = -1;
    for (let i = open, depth = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    const head = text.slice(0, open).trim().split(/\s+/);
    const name = head.pop();
    if (!name || !/^\w+$/.test(name)) continue;
    const entry: DocMethod = { name, isStatic, params: splitTopLevel(text.slice(open + 1, close)) };
    if (head.length) entry.returns = head.join(' ');
    const description = plainText(text.slice(close + 1));
    if (description) entry.description = description;
    out.push(entry);
  }
  return out;
}
