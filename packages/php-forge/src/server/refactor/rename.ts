// Renommer : variables (portée, chaîne d'inclusion), paramètres (et arguments nommés des appels), fonctions,
// classes (use, types, phpdoc, chaînes « Classe::methode »), méthodes, propriétés, constantes. Refusé pour les
// symboles natifs et ceux d'une librairie.
import * as l10n from '@vscode/l10n';
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import type { Position, Range } from '../../shared/types.ts';
import { resolveClassName, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node } from '../parser/parser.ts';
import { namespaceAt, renameNamespace } from './namespace.ts';
import { findReferences, positionsOf, targetAt, type RefEnv, type SourceFile, type Target } from './references.ts';
import { variableReferences, variableTarget, type VariableTarget } from './variables.ts';

const IDENTIFIER = /^[A-Za-z_\x80-￿][\w\x80-￿]*$/;
const PARAMETERS = new Set(['simple_parameter', 'variadic_parameter', 'property_promotion_parameter']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Result<T> = T | { error: string };

/** Plage du nom sous le curseur (sans « $ », dernier segment d'un nom qualifié). */
function nameRangeAt(file: SourceFile, pos: Position, name: string): Range | undefined {
  const line = file.text.split('\n')[pos.line] ?? '';
  for (const match of line.matchAll(new RegExp(`(?<![\\w])${escape(name)}(?!\\w)`, 'gi'))) {
    if (match.index <= pos.character && pos.character <= match.index + name.length) {
      return { start: { line: pos.line, character: match.index }, end: { line: pos.line, character: match.index + name.length } };
    }
  }
  return undefined;
}

function checkTarget(target: Target, isLibrary: (uri: string) => boolean): string | undefined {
  if (target.declarations.some((d) => d.uri.startsWith('phpstub:'))) return l10n.t('Built-in PHP symbols cannot be renamed');
  if (target.declarations.some((d) => isLibrary(d.uri))) return l10n.t('Symbols declared in a library cannot be renamed');
  return undefined;
}

export function prepareRename(env: RefEnv, file: SourceFile, pos: Position, isLibrary: (uri: string) => boolean): Result<{ range: Range; placeholder: string }> {
  const namespace = namespaceAt(file, pos);
  if (namespace) {
    const start = (file.text.split('\n')[pos.line] ?? '').indexOf(namespace);
    return { range: { start: { line: pos.line, character: start }, end: { line: pos.line, character: start + namespace.length } }, placeholder: namespace };
  }
  const variable = variableTarget(file, pos);
  if (variable) {
    const range = nameRangeAt(file, pos, variable.name);
    return range ? { range, placeholder: variable.name } : { error: l10n.t('This element cannot be renamed') };
  }
  const target = targetAt(env, file, pos);
  if (!target) return { error: l10n.t('This element cannot be renamed') };
  const refused = checkTarget(target, isLibrary);
  if (refused) return { error: refused };
  const range = nameRangeAt(file, pos, target.name);
  return range ? { range, placeholder: target.name } : { error: l10n.t('This element cannot be renamed') };
}

export function renameAt(env: RefEnv, file: SourceFile, pos: Position, newName: string, isLibrary: (uri: string) => boolean): Result<WorkspaceEdit> {
  const namespace = namespaceAt(file, pos);
  if (namespace) return /^[A-Za-z_]\w*(\\[A-Za-z_]\w*)*$/.test(newName) ? renameNamespace(env, namespace, newName) : { error: l10n.t('{0} is not a valid name', newName) };
  const name = newName.replace(/^\$/, '');
  if (!IDENTIFIER.test(name)) return { error: l10n.t('{0} is not a valid name', newName) };
  const prepared = prepareRename(env, file, pos, isLibrary);
  if ('error' in prepared) return prepared;
  const changes: Record<string, TextEdit[]> = {};
  const add = (uri: string, range: Range) => {
    const list = (changes[uri] ??= []);
    if (!list.some((e) => e.range.start.line === range.start.line && e.range.start.character === range.start.character)) list.push({ range, newText: name });
  };
  const variable = variableTarget(file, pos);
  if (variable) {
    for (const location of variableReferences(env, file, variable)) add(location.uri, location.range);
    for (const location of namedArguments(env, file, variable)) add(location.uri, location.range);
    return { changes };
  }
  const target = targetAt(env, file, pos)!;
  for (const location of findReferences(env, target, true)) add(location.uri, location.range);
  if (target.kind === 'class') for (const location of docReferences(env, target)) add(location.uri, location.range);
  return { changes };
}

/** Paramètre : arguments nommés `nom: …` des appels de sa fonction. */
function namedArguments(env: RefEnv, file: SourceFile, variable: VariableTarget): { uri: string; range: Range }[] {
  const declaration = variable.root;
  const isParam = (declaration.childForFieldName('parameters')?.namedChildren ?? []).some((p) => PARAMETERS.has(p.type) && p.childForFieldName('name')?.text === `$${variable.name}`);
  const nameNode = declaration.childForFieldName('name');
  if (!isParam || !nameNode) return [];
  const target = targetAt(env, file, rangeOf(nameNode).start);
  if (!target) return [];
  const out: { uri: string; range: Range }[] = [];
  // Appels groupés par fichier : chaque fichier lu une fois
  const byFile = new Map<string, Range[]>();
  for (const location of findReferences(env, target, false)) byFile.set(location.uri, [...(byFile.get(location.uri) ?? []), location.range]);
  for (const [uri, ranges] of byFile) {
    const source = env.source(uri);
    if (!source) continue;
    try {
      for (const range of ranges) {
        let call: Node | null = source.file.tree.rootNode.descendantForPosition({ row: range.start.line, column: range.start.character });
        while (call && !call.type.endsWith('call_expression') && call.type !== 'object_creation_expression') call = call.parent;
        for (const argument of call?.childForFieldName('arguments')?.namedChildren ?? []) {
          const label = argument.type === 'argument' ? argument.childForFieldName('name') : null;
          if (label?.text === variable.name) out.push({ uri, range: rangeOf(label) });
        }
      }
    } finally {
      source.release();
    }
  }
  return out;
}

/** Classe : noms dans les commentaires phpdoc (@var, @param, @return…) qui la désignent. */
function docReferences(env: RefEnv, target: Target): { uri: string; range: Range }[] {
  const fqns = new Set(target.declarations.map((d) => d.symbol.fqn?.toLowerCase()));
  const pattern = new RegExp(`(?<![\\w$])\\\\?(?:[\\w\\\\]+\\\\)?${escape(target.name)}(?!\\w)`, 'gi');
  const out: { uri: string; range: Range }[] = [];
  for (const symbols of env.files()) {
    if (symbols.uri.startsWith('phpstub:') || !symbols.names?.includes(target.name.toLowerCase())) continue;
    const source = env.source(symbols.uri);
    if (!source) continue;
    try {
      const at = positionsOf(source.file.text);
      for (const comment of source.file.tree.rootNode.descendantsOfType('comment')) {
        if (!comment.text.startsWith('/**')) continue;
        for (const match of comment.text.matchAll(pattern)) {
          const start = at(comment.startIndex + match.index);
          const fqn = resolveClassName(match[0], scopeAt(source.file.symbols.scopes, start));
          if (!fqn || !fqns.has(fqn.toLowerCase())) continue;
          const shortStart = comment.startIndex + match.index + match[0].length - target.name.length;
          const pos = at(shortStart);
          out.push({ uri: symbols.uri, range: { start: pos, end: { line: pos.line, character: pos.character + target.name.length } } });
        }
      }
    } finally {
      source.release();
    }
  }
  return out;
}

