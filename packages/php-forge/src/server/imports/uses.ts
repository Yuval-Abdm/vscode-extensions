// Instructions `use` du fichier : ajout d'un import à sa place dans l'ordre alphabétique (après le namespace ou
// <?php s'il n'y en a pas), détection d'un conflit de nom court, organisation (tri, regroupement par sorte —
// classes, fonctions, constantes —, suppression des inutilisés, groupes dépliés).
import type { TextEdit } from 'vscode-languageserver/node';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { usedNames } from '../diagnostics/code.ts';

export type UseKind = 'class' | 'function' | 'const';

interface UseEntry {
  kind: UseKind;
  fqn: string;
  alias?: string;
  declaration: Node;
}

const ORDER: Record<UseKind, number> = { class: 0, function: 1, const: 2 };
const keyword = (kind: UseKind) => (kind === 'class' ? '' : `${kind} `);
const shortOf = (entry: { fqn: string; alias?: string }) => (entry.alias ?? entry.fqn.slice(entry.fqn.lastIndexOf('\\') + 1)).toLowerCase();

/** Déclarations use du niveau fichier (ou du premier namespace), dans l'ordre. */
function declarations(tree: Tree): Node[] {
  const root = tree.rootNode;
  const direct = root.namedChildren.filter((c) => c.type === 'namespace_use_declaration');
  if (direct.length) return direct;
  const namespace = root.namedChildren.find((c) => c.type === 'namespace_definition');
  return (namespace?.childForFieldName('body')?.namedChildren ?? []).filter((c) => c.type === 'namespace_use_declaration');
}

const entryCache = new WeakMap<Tree, UseEntry[]>();

/** Imports du fichier, calculés une fois par arbre (la complétion interroge chaque élément proposé). */
function entries(tree: Tree): UseEntry[] {
  let cached = entryCache.get(tree);
  if (!cached) entryCache.set(tree, (cached = readEntries(tree)));
  return cached;
}

function readEntries(tree: Tree): UseEntry[] {
  const out: UseEntry[] = [];
  for (const declaration of declarations(tree)) {
    const declared = declaration.children.find((c) => !c.isNamed && (c.type === 'function' || c.type === 'const'))?.type as UseKind | undefined;
    const group = declaration.childForFieldName('body');
    const prefix = group ? (declaration.namedChildren.find((c) => c.type === 'namespace_name')?.text ?? '') : '';
    for (const clause of (group ?? declaration).namedChildren) {
      if (clause.type !== 'namespace_use_clause') continue;
      const target = clause.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'name');
      if (!target) continue;
      const own = clause.children.find((c) => !c.isNamed && (c.type === 'function' || c.type === 'const'))?.type as UseKind | undefined;
      const fqn = (prefix ? `${prefix}\\${target.text}` : target.text).replace(/^\\/, '').replace(/\s+/g, '');
      const alias = clause.childForFieldName('alias')?.text;
      out.push({ kind: own ?? declared ?? 'class', fqn, ...(alias ? { alias } : {}), declaration });
    }
  }
  return out;
}

const DECLARATIONS: Record<UseKind, string[]> = {
  class: ['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration'],
  function: ['function_definition'],
  const: ['const_element'],
};

/** Nom court déjà importé pour un autre nom complet, ou déclaré dans le fichier. */
export function useConflict(tree: Tree, fqn: string, kind: UseKind): boolean {
  const short = shortOf({ fqn });
  if (entries(tree).some((e) => e.kind === kind && shortOf(e) === short && e.fqn.toLowerCase() !== fqn.toLowerCase())) return true;
  return declaredNames(tree, kind).has(short);
}

const declaredCache = new WeakMap<Tree, Map<UseKind, Set<string>>>();

/** Noms courts (minuscules) déclarés dans le fichier, par sorte, calculés une fois par arbre. */
function declaredNames(tree: Tree, kind: UseKind): Set<string> {
  let byKind = declaredCache.get(tree);
  if (!byKind) declaredCache.set(tree, (byKind = new Map()));
  let names = byKind.get(kind);
  if (!names) {
    names = new Set();
    for (const d of tree.rootNode.descendantsOfType(DECLARATIONS[kind])) {
      const name = d.childForFieldName('name') ?? d.namedChildren.find((c) => c.type === 'name');
      if (name) names.add(name.text.toLowerCase());
    }
    byKind.set(kind, names);
  }
  return names;
}

export function addUse(tree: Tree, text: string, fqn: string, kind: UseKind): TextEdit | undefined {
  const clean = fqn.replace(/^\\/, '');
  const existing = entries(tree);
  if (existing.some((e) => e.kind === kind && e.fqn.toLowerCase() === clean.toLowerCase())) return undefined;
  const line = `use ${keyword(kind)}${clean};\n`;
  const lines = text.split('\n');
  if (existing.length) {
    // Avant la première déclaration simple qui vient après dans l'ordre, sinon après la dernière
    const key = `${ORDER[kind]}${clean.toLowerCase()}`;
    const next = existing.find((e) => !e.declaration.childForFieldName('body') && `${ORDER[e.kind]}${e.fqn.toLowerCase()}` > key);
    const anchorLine = next ? rangeOf(next.declaration).start.line : rangeOf(existing[existing.length - 1].declaration).end.line + 1;
    return { range: { start: { line: anchorLine, character: 0 }, end: { line: anchorLine, character: 0 } }, newText: line };
  }
  const root = tree.rootNode;
  const namespace = root.namedChildren.find((c) => c.type === 'namespace_definition' && !c.childForFieldName('body'));
  const tag = root.namedChildren.find((c) => c.type === 'php_tag');
  // Fichier qui commence par du HTML : l'ajout tomberait dans le HTML
  if (!namespace && root.namedChildren[0]?.type === 'text' && root.namedChildren[0].text.trim() !== '') return undefined;
  // Après le namespace, sinon après les declare(…) du début, sinon après <?php
  const declares = root.namedChildren.filter((c) => c.type === 'declare_statement');
  const anchor = namespace ?? declares[declares.length - 1] ?? tag;
  if (anchor && (lines[rangeOf(anchor).end.line] ?? '').slice(rangeOf(anchor).end.character).includes('?>')) return undefined;
  let at = (anchor ? rangeOf(anchor).end.line : 0) + 1;
  if ((lines[at] ?? '').trim() === '' && at < lines.length - 1) at++;
  const blankAfter = (lines[at] ?? '').trim() === '' ? '' : '\n';
  return { range: { start: { line: at, character: 0 }, end: { line: at, character: 0 } }, newText: `${line}${blankAfter}` };
}

export function organizeUses(tree: Tree, text: string): TextEdit[] {
  const decls = declarations(tree);
  if (!decls.length) return [];
  const first = rangeOf(decls[0]).start.line;
  const last = rangeOf(decls[decls.length - 1]).end.line;
  const lines = text.split('\n');
  // Un commentaire ou du code entre les use : on ne touche à rien (rien ne doit se perdre)
  // Une déclaration qui partage sa ligne avec du code : on ne touche à rien
  if (decls.some((d) => (lines[rangeOf(d).start.line] ?? '').trim() !== d.text.trim() && rangeOf(d).start.line === rangeOf(d).end.line)) return [];
  const between = lines.slice(first, last + 1).filter((l, i) => !decls.some((d) => rangeOf(d).start.line <= first + i && first + i <= rangeOf(d).end.line) && l.trim() !== '');
  if (between.length) return [];
  const { names, docs } = usedNames(tree);
  const kept = entries(tree).filter((e) => names.has(shortOf(e)) || (e.kind === 'class' && docs.has(shortOf(e))));
  const unique = [...new Map(kept.map((e) => [`${e.kind}:${e.fqn.toLowerCase()}:${e.alias ?? ''}`, e])).values()];
  unique.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.fqn.toLowerCase().localeCompare(b.fqn.toLowerCase()));
  const groups: string[] = [];
  for (const kind of ['class', 'function', 'const'] as UseKind[]) {
    const group = unique.filter((e) => e.kind === kind).map((e) => `use ${keyword(kind)}${e.fqn}${e.alias ? ` as ${e.alias}` : ''};`);
    if (group.length) groups.push(group.join('\n'));
  }
  const replacement = groups.join('\n\n');
  const current = lines.slice(first, last + 1).join('\n');
  if (replacement === current) return [];
  const end = { line: last, character: lines[last].length };
  // Plus aucun use : la ligne vide qui suivait le bloc part aussi
  if (!replacement) return [{ range: { start: { line: first, character: 0 }, end: { line: last + ((lines[last + 1] ?? '').trim() === '' ? 2 : 1), character: 0 } }, newText: '' }];
  return [{ range: { start: { line: first, character: 0 }, end }, newText: replacement }];
}
