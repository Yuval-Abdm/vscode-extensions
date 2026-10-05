// Imports proposés sur un nom inconnu : « Import Lib\User » pour chaque déclaration de même nom court ayant un
// namespace (projet, Composer, PHP) ; pour un symbole déclaré dans un fichier du projet sans namespace, ou signalé
// non inclus, « Add include '…' » dans le style du fichier. « Import all missing classes » quand chaque classe
// inconnue n'a qu'un candidat.
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import { CodeActionKind, type CodeAction, type Diagnostic, type TextEdit } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import type { FileSymbols, PhpSymbol } from '../../shared/types.ts';
import type { IncludeGraph } from '../includes/graph.ts';
import type { Lookup } from '../index/lookup.ts';
import type { Tree } from '../parser/parser.ts';
import { includeEdit, includeStatement } from './includeStyle.ts';
import { addUse, useConflict, type UseKind } from './uses.ts';

export interface FixInput {
  uri: string;
  fsPath: string;
  text: string;
  tree: Tree;
  symbols: FileSymbols;
}

export interface FixEnv {
  lookup: Lookup;
  graph?: IncludeGraph;
}

type SymbolData = { symbol?: { kind: 'class' | 'function' | 'constant'; name: string }; declaredIn?: string[] };

const USE_KIND: Record<string, UseKind> = { class: 'class', function: 'function', constant: 'const' };
const CLASS_LIKE = new Set(['class', 'interface', 'trait', 'enum']);

/** Déclarations du projet et de PHP qui portent ce nom court. */
function candidates(env: FixEnv, kind: 'class' | 'function' | 'constant', name: string): { uri: string; symbol: PhpSymbol }[] {
  const lower = name.toLowerCase();
  const out: { uri: string; symbol: PhpSymbol }[] = [];
  for (const index of [env.lookup.workspace, env.lookup.stubs]) {
    for (const file of index.files()) {
      for (const symbol of file.symbols) {
        const matches = kind === 'class' ? CLASS_LIKE.has(symbol.kind) : symbol.kind === kind;
        if (!matches || !symbol.fqn) continue;
        if ((kind === 'constant' ? symbol.name === name : symbol.name.toLowerCase() === lower)) out.push({ uri: file.uri, symbol });
      }
    }
  }
  return out.sort((a, b) => a.symbol.fqn!.localeCompare(b.symbol.fqn!));
}

function action(title: string, uri: string, edits: TextEdit[], diagnostics: Diagnostic[], kind: string = CodeActionKind.QuickFix): CodeAction {
  return { title, kind, diagnostics, edit: { changes: { [uri]: edits } } };
}

/** Chemin affiché : depuis la racine du projet, sinon depuis le dossier du fichier. */
const relative = (graph: IncludeGraph | undefined, from: string, target: string) => {
  const root = graph?.roots.find((r) => target.startsWith(r + path.sep));
  return path.relative(root ?? path.dirname(from), target).split(path.sep).join('/');
};

export function importFixes(input: FixInput, diagnostics: Diagnostic[], env: FixEnv): CodeAction[] {
  const out: CodeAction[] = [];
  const seen = new Set<string>();
  const addInclude = (targetUri: string, d: Diagnostic) => {
    const target = URI.parse(targetUri).fsPath;
    if (seen.has(target) || targetUri === input.uri) return;
    seen.add(target);
    const statement = includeStatement(input, target, env.graph);
    out.push(action(l10n.t("Add include '{0}'", relative(env.graph, input.fsPath, target)), input.uri, [includeEdit(input.tree, statement)], [d]));
  };
  for (const d of diagnostics) {
    const data = (d.data ?? {}) as SymbolData;
    if (d.code === 'symbol-not-included') {
      for (const uri of data.declaredIn ?? []) addInclude(uri, d);
      continue;
    }
    if (!data.symbol || !['undefined-class', 'undefined-function', 'undefined-constant'].includes(String(d.code))) continue;
    for (const { uri, symbol } of candidates(env, data.symbol.kind, data.symbol.name)) {
      const fqn = symbol.fqn!;
      if (fqn.includes('\\')) {
        const kind = USE_KIND[data.symbol.kind];
        if (useConflict(input.tree, fqn, kind)) continue;
        const edit = addUse(input.tree, input.text, fqn, kind);
        if (edit && !seen.has(fqn)) {
          seen.add(fqn);
          out.push(action(l10n.t('Import {0}', fqn), input.uri, [edit], [d]));
        }
      } else if (!uri.startsWith('phpstub:')) {
        addInclude(uri, d);
      }
    }
  }
  return out;
}

export function importAllMissing(input: FixInput, diagnostics: Diagnostic[], env: FixEnv): CodeAction | undefined {
  const unique = new Map<string, string>();
  for (const d of diagnostics) {
    const data = (d.data ?? {}) as SymbolData;
    if (d.code !== 'undefined-class' || data.symbol?.kind !== 'class') continue;
    const found = candidates(env, 'class', data.symbol.name).filter((c) => c.symbol.fqn!.includes('\\'));
    if (found.length === 1) unique.set(data.symbol.name.toLowerCase(), found[0].symbol.fqn!);
  }
  if (unique.size < 2) return undefined;
  const fqns = [...unique.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const first = addUse(input.tree, input.text, fqns[0], 'class');
  if (!first) return undefined;
  // Une seule insertion : toutes les lignes ensemble, au point d'insertion du premier
  const lines = fqns.map((fqn) => `use ${fqn};\n`).join('');
  const newText = first.newText.replace(/^use [^\n]+\n/, lines);
  return action(l10n.t('Import all missing classes'), input.uri, [{ range: first.range, newText }], [], CodeActionKind.Source.concat('.addMissingImports'));
}
