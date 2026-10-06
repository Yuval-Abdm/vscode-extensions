// Code mort : `use` jamais utilisés (noms et commentaires phpdoc du fichier) et instructions après un return,
// throw, exit, die, break ou continue dans le même bloc. Niveau indice, texte grisé.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, DiagnosticTag, type Diagnostic } from 'vscode-languageserver/node';
import type { Range } from '../../shared/types.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';

const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);
const BLOCKS = new Set(['program', 'compound_statement', 'colon_block', 'case_statement', 'default_statement']);
const TERMINATORS = new Set(['return_statement', 'exit_statement', 'break_statement', 'continue_statement', 'goto_statement']);
/** Toujours atteintes ou sans effet : déclarations remontées par PHP, HTML, commentaires */
const NEVER_UNREACHABLE = new Set([
  'function_definition', 'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration',
  'text_interpolation', 'comment', 'empty_statement', 'namespace_use_declaration', 'const_declaration',
]);

function hint(range: Range, code: string, message: string): Diagnostic {
  return { range, code, message, severity: DiagnosticSeverity.Hint, tags: [DiagnosticTag.Unnecessary], source: 'PHP Forge' };
}

export function codeDiagnostics(tree: Tree): Diagnostic[] {
  return [...unusedUses(tree), ...unreachable(tree)].sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

/** Premiers segments des noms utilisés (hors déclarations use et namespace) et identifiants des commentaires phpdoc. */
export function usedNames(tree: Tree): { names: Set<string>; docs: Set<string> } {
  const names = new Set<string>();
  const docs = new Set<string>();
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'namespace_use_declaration' || child.type === 'namespace_name' && node.type === 'namespace_definition') continue;
      if (child.type === 'comment') {
        if (child.text.startsWith('/**')) for (const word of child.text.match(/[A-Za-z_\\][\w\\]*/g) ?? []) docs.add(word.replace(/^\\/, '').split('\\')[0].toLowerCase());
        continue;
      }
      if (NAME_TYPES.has(child.type)) {
        names.add(child.text.replace(/^\\/, '').split('\\')[0].replace(/\s+/g, '').toLowerCase());
        continue;
      }
      visit(child);
    }
  };
  visit(tree.rootNode);
  return { names, docs };
}

function unusedUses(tree: Tree): Diagnostic[] {
  const declarations = tree.rootNode.descendantsOfType('namespace_use_declaration');
  if (!declarations.length) return [];
  const { names, docs } = usedNames(tree);
  const out: Diagnostic[] = [];
  for (const declaration of declarations) {
    const keyword = declaration.children.find((c) => !c.isNamed && (c.type === 'function' || c.type === 'const'))?.type;
    const group = declaration.childForFieldName('body');
    for (const clause of (group ?? declaration).namedChildren) {
      if (clause.type !== 'namespace_use_clause') continue;
      const target = clause.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'name');
      if (!target) continue;
      const alias = clause.childForFieldName('alias')?.text ?? target.text.split('\\').pop()!;
      const key = alias.toLowerCase();
      const used = names.has(key) || (!keyword && docs.has(key));
      if (!used) out.push(hint(rangeOf(group ? clause : target), 'unused-use', l10n.t('Unused use statement: {0}', group ? target.text : target.text.replace(/^\\/, ''))));
    }
  }
  return out;
}

function isTerminator(statement: Node): boolean {
  if (TERMINATORS.has(statement.type)) return true;
  if (statement.type !== 'expression_statement') return false;
  const expression = statement.namedChildren[0];
  if (expression?.type === 'throw_expression') return true;
  const fn = expression?.type === 'function_call_expression' ? expression.childForFieldName('function')?.text.toLowerCase() : undefined;
  return fn === 'die' || fn === 'exit';
}

function unreachable(tree: Tree): Diagnostic[] {
  const out: Diagnostic[] = [];
  const visit = (node: Node): void => {
    const children = node.namedChildren;
    if (BLOCKS.has(node.type)) {
      const value = node.type === 'case_statement' ? node.childForFieldName('value') : null;
      const statements = children.filter((c) => c.id !== value?.id);
      const stop = statements.findIndex(isTerminator);
      if (stop >= 0) {
        const after = statements.slice(stop + 1);
        // Une étiquette de goto rend la suite atteignable
        const label = after.findIndex((s) => s.type === 'named_label_statement');
        const dead = (label < 0 ? after : after.slice(0, label)).filter((s) => !NEVER_UNREACHABLE.has(s.type));
        if (dead.length) out.push(hint({ start: rangeOf(dead[0]).start, end: rangeOf(dead[dead.length - 1]).end }, 'unreachable-code', l10n.t('Unreachable code')));
      }
    }
    for (const child of children) visit(child);
  };
  visit(tree.rootNode);
  return out;
}
