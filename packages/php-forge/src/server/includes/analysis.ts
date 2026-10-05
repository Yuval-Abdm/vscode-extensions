// Moteur d'inclusion (§4.5) : exécution symbolique des programmes de variables depuis chaque script d'entrée, en
// suivant les inclusions. L'état (variables certaines / peut-être, constantes, fichiers chargés) est fait de
// couches : une par branche et par fichier inclus, fusionnées ensuite. Chaque fichier est exécuté une fois par
// empreinte de son contexte d'entrée (mémoïsation, au plus `maxContexts`) ; ses résultats sont rattachés à
// l'appelant (« script#ligne ») pour la règle stricte : une lecture est signalée dès qu'un contexte ne définit pas
// la variable, avec la liste des appelants fautifs.
import type { FileSymbols, FlowFunction, FlowOp, Loc, PhpParam, PhpSymbol, Position, Range, TypeExpr } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { SymbolIndex } from '../index/symbolIndex.ts';
import { union } from '../types/type.ts';
import { walkOps, type IncludeGraph } from './graph.ts';
import { evaluatePath, resolveInclude, type ResolveEnv } from './resolve.ts';

export interface VarInfo {
  certain: boolean;
  /** Affectation qui définit la variable */
  origin?: { uri: string; line: number };
  type?: TypeExpr;
  /** Variable venue de la requête par `extract($_POST)` */
  request?: { from: string; line: number };
}

export interface AnalysisOptions {
  /** Contextes d'entrée distincts analysés par fichier ; au-delà, analyse approximative */
  maxContexts: number;
  /** Variables définies par l'environnement (`phpForge.externalGlobals`) */
  externalGlobals: string[];
}

export interface ReadIssue {
  name: string;
  at: Loc;
  end: number;
  kind: 'undefined' | 'maybe';
}

export interface SymbolNeed {
  kind: 'function' | 'class' | 'constant';
  name: string;
  /** Fichiers qui déclarent le symbole */
  declaredIn: string[];
  at: Loc;
  end: number;
  /** Fonction qui contient l'utilisation (« f », « Classe::m », « closure ») ; absent : niveau fichier */
  fn?: string;
}

export interface UnresolvedInclude {
  index: number;
  /** Chemin évalué mais fichier introuvable (sinon : chemin dynamique) */
  evaluated: boolean;
}

export interface ReadReport extends ReadIssue {
  /** Appelants où la lecture pose problème (« uri#ligne », vide : script seul, « function ») */
  via: string[];
  /** Appelants où la variable est définie */
  others: number;
}

export interface SymbolReport {
  need: SymbolNeed;
  via: string[];
  others: number;
}

export interface DuplicateReport {
  /** Nom déclaré deux fois, ou fichier inclus deux fois */
  name: string;
  /** Fichier qui le déclare déjà (ou le fichier inclus lui-même) */
  other: string;
  range: Range;
  via: string[];
  others: number;
}

export interface FileReport {
  duplicates: DuplicateReport[];
  reads: ReadReport[];
  symbols: SymbolReport[];
  unresolved: UnresolvedInclude[];
  approximate: boolean;
  contexts: string[];
}

interface Collector {
  reads: ReadIssue[];
  unresolved: UnresolvedInclude[];
  needs: SymbolNeed[];
}

/** Effet d'un fichier sur l'état de l'appelant. */
interface Delta {
  vars: Map<string, VarInfo | null>;
  constants: Map<string, string | undefined>;
  loaded: Set<string>;
  stop: boolean;
  request?: { from: string; line: number };
  autoload: boolean;
  exit: boolean;
  declared: Map<string, string>;
}

/** Ce qu'une exécution a lu du contexte en plus des variables (vérifié avant de la réutiliser). */
interface Deps {
  /** Fichiers `_once` sautés parce que l'appelant les avait déjà chargés */
  once: Set<string>;
  /** Constantes lues chez l'appelant, avec leur valeur */
  constants: Map<string, string | undefined>;
}

interface Run extends Collector {
  delta: Delta;
  deps: Deps;
  /** Fonctions appelées par le fichier et ceux qu'il inclut (noms courts en minuscules) */
  calls: Set<string>;
}

interface FileAnalysis {
  /** Exécutions mémorisées par empreinte des variables (variantes selon les dépendances) */
  runs: Map<string, Run[]>;
  stored: number;
  /** Au-delà de maxContexts : réunion des exécutions, partagée par les contextes suivants */
  union?: Run;
  /** Contexte d'entrée par appelant */
  contexts: Map<string, { run: Run; missing: SymbolNeed[] }>;
  approximate: boolean;
  /** Variables à l'entrée du premier contexte (survol, complétion) */
  entry?: Map<string, VarInfo>;
  functions?: Collector;
}

interface Ctx {
  uri: string;
  file: FileSymbols;
  fsPath: string;
  /** Script d'entrée de la chaîne (chemins relatifs) */
  entry?: string;
  via: string;
  /** Au niveau fichier d'un script d'entrée : ses includes donnent le libellé des appelants */
  top: boolean;
  /** Couche de départ de l'exécution du fichier */
  base: Layer;
  collector: Collector;
  deps: Deps;
  calls: Set<string>;
  /** Exécution pour le survol ou la complétion : rien n'est enregistré */
  probe: boolean;
  until?: Loc;
  halt?: Layer;
}

const MAX_DEPTH = 40;
const DECLARED_KINDS = new Set(['function', 'class', 'interface', 'trait', 'enum']);
const fileName = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

/** Fonctions et classes déclarées sans condition par le fichier (clé → symbole). */
function declarations(file: FileSymbols): Map<string, PhpSymbol> {
  const out = new Map<string, PhpSymbol>();
  for (const symbol of file.symbols) {
    if (!DECLARED_KINDS.has(symbol.kind) || symbol.conditional || !symbol.fqn) continue;
    out.set(`${symbol.kind === 'function' ? 'function' : 'class'}:${symbol.fqn.toLowerCase()}`, symbol);
  }
  return out;
}
const shortName = (name: string) => name.slice(name.lastIndexOf('\\') + 1).toLowerCase();
const before = (a: Loc, b: Loc) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** Couche d'état : modifications par rapport à la couche parente. */
export class Layer {
  readonly parent?: Layer;
  readonly vars = new Map<string, VarInfo | null>();
  readonly constants = new Map<string, string | undefined>();
  readonly loaded = new Set<string>();
  /** Fonctions et classes déclarées sans condition dans la chaîne (clé → fichier) */
  readonly declared = new Map<string, string>();
  /** Plus d'alerte de variable non définie (dynamique, extract, include non résolu) */
  stop: boolean;
  request?: { from: string; line: number };
  autoload: boolean;
  exit?: 'exit' | 'return';

  constructor(parent?: Layer) {
    this.parent = parent;
    this.stop = parent?.stop ?? false;
    this.request = parent?.request;
    this.autoload = parent?.autoload ?? false;
  }

  get(name: string): VarInfo | undefined {
    for (let layer: Layer | undefined = this; layer; layer = layer.parent) {
      const value = layer.vars.get(name);
      if (value !== undefined) return value ?? undefined;
    }
    return undefined;
  }

  constant(name: string): string | undefined {
    for (let layer: Layer | undefined = this; layer; layer = layer.parent) {
      if (layer.constants.has(name)) return layer.constants.get(name);
    }
    return undefined;
  }

  declaredBy(key: string): string | undefined {
    for (let layer: Layer | undefined = this; layer; layer = layer.parent) {
      const uri = layer.declared.get(key);
      if (uri) return uri;
    }
    return undefined;
  }

  /** Constante définie dans cette couche ou ses parentes jusqu'à `until` exclue (undefined : pas trouvée). */
  ownConstant(name: string, until?: Layer): { value: string | undefined } | undefined {
    for (let layer: Layer | undefined = this; layer && layer !== until; layer = layer.parent) {
      if (layer.constants.has(name)) return { value: layer.constants.get(name) };
    }
    return undefined;
  }

  /** Fichier chargé dans cette couche ou ses parentes, jusqu'à `until` exclue. */
  isLoaded(uri: string, until?: Layer): boolean {
    for (let layer: Layer | undefined = this; layer && layer !== until; layer = layer.parent) {
      if (layer.loaded.has(uri)) return true;
    }
    return false;
  }

  flatten(): Map<string, VarInfo> {
    const chain: Layer[] = [];
    for (let layer: Layer | undefined = this; layer; layer = layer.parent) chain.push(layer);
    const out = new Map<string, VarInfo>();
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const [name, value] of chain[i].vars) {
        if (value) out.set(name, value);
        else out.delete(name);
      }
    }
    return out;
  }

  /** Empreinte du contexte : variables (et leur certitude) et drapeaux. */
  fingerprint(): string {
    const vars = this.flatten();
    const names = [...vars.keys()].sort().map((name) => (vars.get(name)!.certain ? name : `?${name}`));
    return `${this.stop ? 's' : ''}${this.request ? 'r' : ''}${this.autoload ? 'a' : ''}|${names.join(',')}`;
  }

  delta(): Delta {
    return {
      vars: new Map(this.vars),
      constants: new Map(this.constants),
      loaded: new Set(this.loaded),
      stop: this.stop,
      request: this.request,
      autoload: this.autoload,
      exit: this.exit === 'exit',
      declared: new Map(this.declared),
    };
  }

  apply(delta: Delta): void {
    for (const [name, value] of delta.vars) this.vars.set(name, value);
    for (const [name, value] of delta.constants) if (this.constant(name) === undefined) this.constants.set(name, value);
    for (const uri of delta.loaded) this.loaded.add(uri);
    this.stop ||= delta.stop;
    this.request ??= delta.request;
    this.autoload ||= delta.autoload;
    if (delta.exit) this.exit = 'exit';
    for (const [key, uri] of delta.declared) if (!this.declaredBy(key)) this.declared.set(key, uri);
  }
}

/** Fusion des branches dans la couche parente ; `exhaustive` : pas de chemin vide implicite. */
function merge(parent: Layer, alts: Layer[], exhaustive: boolean): void {
  const live = alts.filter((alt) => !alt.exit);
  if (exhaustive && live.length === 0) {
    parent.exit = alts.some((alt) => alt.exit === 'return') ? 'return' : 'exit';
    return;
  }
  const paths: (Layer | undefined)[] = exhaustive ? live : [...live, undefined];
  const names = new Set<string>();
  for (const alt of live) for (const name of alt.vars.keys()) names.add(name);
  for (const name of names) {
    let certain = true;
    let defined = false;
    let first: VarInfo | undefined;
    const types: TypeExpr[] = [];
    for (const path of paths) {
      const info = path ? path.get(name) : parent.get(name);
      if (!info) {
        certain = false;
        continue;
      }
      defined = true;
      if (!info.certain) certain = false;
      first ??= info;
      if (info.type) types.push(info.type);
    }
    if (!defined || !first) {
      parent.vars.set(name, null);
      continue;
    }
    const merged: VarInfo = { ...first, certain };
    if (types.length) merged.type = types.length === 1 ? types[0] : union(...types);
    else delete merged.type;
    parent.vars.set(name, merged);
  }
  for (const alt of live) {
    for (const [name, value] of alt.constants) if (parent.constant(name) === undefined) parent.constants.set(name, value);
    for (const uri of alt.loaded) parent.loaded.add(uri);
    for (const [key, uri] of alt.declared) if (!parent.declaredBy(key)) parent.declared.set(key, uri);
    parent.stop ||= alt.stop;
    parent.request ??= alt.request;
    parent.autoload ||= alt.autoload;
  }
}

function paramByRef(params: PhpParam[] | undefined, index: number): boolean {
  const last = params?.[params.length - 1];
  const param = params?.[index] ?? (last?.variadic ? last : undefined);
  return !!param?.byRef;
}

export class IncludeAnalysis {
  readonly graph: IncludeGraph;
  readonly #index: SymbolIndex;
  readonly #lookup: Lookup;
  readonly #options: AnalysisOptions;
  readonly #files = new Map<string, FileAnalysis>();
  readonly #stack: string[] = [];
  readonly #declared = new Map<string, string[]>();
  #methodRefs?: Map<string, Set<number>>;
  readonly #autoloaders = new Map<string, boolean>();
  readonly #lazy = new Map<string, string[]>();
  readonly #duplicates = new Map<string, { name: string; other: string; range: Range; via: string }[]>();
  /** Symboles des fonctions des fichiers atteints par le script d'entrée en cours, vérifiés à la fin du script */
  #pending?: { context: { missing: SymbolNeed[] }; needs: SymbolNeed[] }[];
  #probeCache?: { key: string; file: FileSymbols | undefined; layer: Layer | undefined };

  constructor(index: SymbolIndex, lookup: Lookup, graph: IncludeGraph, options: AnalysisOptions) {
    this.#index = index;
    this.#lookup = lookup;
    this.graph = graph;
    this.#options = options;
  }

  /**
   * Analyse depuis chaque script d'entrée, puis les fichiers jamais atteints (inclusions circulaires sans
   * point d'entrée) ; les gabarits inclus dynamiquement sont analysés sans alerte.
   */
  run(): void {
    for (const uri of this.#order()) this.#runEntry(uri);
  }

  /**
   * Même analyse, en rendant la main toutes les `every` entrées (le serveur reste réactif) ; `stop()` vrai :
   * interrompue (une modification plus récente relance l'analyse). Renvoie true si elle est allée au bout.
   */
  async runAsync(stop: () => boolean, every = 25): Promise<boolean> {
    let count = 0;
    for (const uri of this.#order()) {
      if (count++ % every === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (stop()) return false;
      }
      this.#runEntry(uri);
    }
    return true;
  }

  /** Scripts d'entrée, puis les fichiers jamais atteints (inclusions circulaires sans point d'entrée). */
  #order(): string[] {
    const entries = this.graph.entries();
    const set = new Set(entries);
    return [...entries, ...this.graph.files().filter((f) => !set.has(f))];
  }

  #runEntry(uri: string): void {
    if (this.#files.has(uri)) return;
    const base = this.#base();
    if (this.graph.isDynamicTarget(uri)) base.stop = true;
    this.#pending = [];
    const run = this.#runFile(uri, base, { entry: this.graph.fsPath(uri), via: '', probe: false, top: true });
    // Le code d'une fonction ne s'exécute que si elle est appelée : seulement les fonctions appelées par la chaîne
    // (pas les méthodes ni les closures, dont l'appel n'est pas suivi), avec ce que le script a chargé à la fin
    const calls = run?.calls ?? new Set<string>();
    if (!base.stop) {
      for (const { context, needs } of this.#pending) {
        context.missing.push(...needs.filter((need) => need.fn && calls.has(need.fn.toLowerCase()) && !need.declaredIn.some((d) => base.isLoaded(d))));
      }
    }
    this.#pending = undefined;
  }


  report(uri: string): FileReport | undefined {
    const state = this.#files.get(uri);
    if (!state) return undefined;
    // Un fichier inclus n'est analysé seul que si personne ne l'inclut (le graphe peut ne pas avoir vu un appelant)
    const all = [...state.contexts];
    const contexts = all.some(([via]) => via !== '' && via !== 'function') ? all.filter(([via]) => via !== '') : all;
    const reads = new Map<string, { issue: ReadIssue; undefinedVia: string[]; maybeVia: string[] }>();
    const symbols = new Map<string, { need: SymbolNeed; via: string[] }>();
    for (const [via, context] of contexts) {
      const run = context.run;
      for (const issue of run.reads) {
        const key = `${issue.at[0]}:${issue.at[1]}`;
        const entry = reads.get(key) ?? { issue, undefinedVia: [], maybeVia: [] };
        (issue.kind === 'undefined' ? entry.undefinedVia : entry.maybeVia).push(via);
        reads.set(key, entry);
      }
      for (const need of context.missing) {
        const key = `${need.at[0]}:${need.at[1]}`;
        const entry = symbols.get(key) ?? { need, via: [] };
        entry.via.push(via);
        symbols.set(key, entry);
      }
    }
    const out: FileReport = { duplicates: [], reads: [], symbols: [], unresolved: [], approximate: state.approximate, contexts: contexts.map(([via]) => via) };
    for (const { issue, undefinedVia, maybeVia } of reads.values()) {
      const via = undefinedVia.length ? undefinedVia : maybeVia;
      out.reads.push({ ...issue, kind: undefinedVia.length ? 'undefined' : 'maybe', via, others: contexts.length - via.length });
    }
    for (const issue of state.functions?.reads ?? []) out.reads.push({ ...issue, via: ['function'], others: 0 });
    for (const { need, via } of symbols.values()) out.symbols.push({ need, via, others: contexts.length - via.length });
    const unresolved = new Map<number, UnresolvedInclude>();
    for (const runs of state.runs.values()) for (const run of runs) for (const u of run.unresolved) unresolved.set(u.index, u);
    for (const u of state.functions?.unresolved ?? []) unresolved.set(u.index, u);
    out.unresolved = [...unresolved.values()].sort((a, b) => a.index - b.index);
    const byKey = new Map<string, DuplicateReport>();
    for (const d of this.#duplicates.get(uri) ?? []) {
      const key = `${d.name}:${d.range.start.line}:${d.range.start.character}`;
      const entry = byKey.get(key) ?? { name: d.name, other: d.other, range: d.range, via: [], others: 0 };
      entry.via.push(d.via);
      byKey.set(key, entry);
    }
    out.duplicates = [...byKey.values()].map((d) => ({ ...d, others: Math.max(0, contexts.length - d.via.length) }));
    out.reads.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    return out;
  }

  /** État des variables juste avant `pos` (premier contexte d'entrée), dans la fonction qui contient `pos`. */
  stateAt(uri: string, pos: Position): Layer | undefined {
    const key = `${uri}:${pos.line}:${pos.character}`;
    const file = this.#index.get(uri);
    // Le résumé change à chaque frappe : le cache ne vaut que pour le même résumé
    if (this.#probeCache?.key === key && this.#probeCache.file === file) return this.#probeCache.layer;
    let layer: Layer | undefined;
    if (file?.flow) {
      const fn = file.flow.functions
        .filter((f) => f.lines[0] <= pos.line && pos.line <= f.lines[1])
        .sort((a, b) => b.lines[0] - a.lines[0])[0];
      const start = fn ? this.#functionLayer(uri, fn) : this.#entryLayer(uri);
      const ctx = this.#ctx(uri, file, { via: '', probe: true, top: false, base: start });
      ctx.until = [pos.line, pos.character];
      this.#exec(fn ? fn.body : file.flow.main, start, ctx);
      layer = ctx.halt ?? start;
    }
    this.#probeCache = { key, file, layer };
    return layer;
  }

  variable(uri: string, name: string, pos: Position): VarInfo | undefined {
    const layer = this.stateAt(uri, pos);
    const info = layer?.get(name);
    if (info) return info;
    return layer?.request && !layer.stop ? { certain: true, request: layer.request } : undefined;
  }

  names(uri: string, pos: Position): string[] {
    return [...(this.stateAt(uri, pos)?.flatten().keys() ?? [])];
  }

  #base(): Layer {
    const layer = new Layer();
    for (const name of this.#options.externalGlobals) layer.vars.set(name.replace(/^\$/, ''), { certain: true });
    for (const uri of this.graph.alwaysLoaded) layer.loaded.add(uri);
    return layer;
  }

  #entryLayer(uri: string): Layer {
    const layer = this.#base();
    for (const [name, info] of this.#files.get(uri)?.entry ?? []) layer.vars.set(name, info);
    return layer;
  }

  #functionLayer(uri: string, fn: FlowFunction): Layer {
    const layer = this.#base();
    for (const name of fn.params) layer.vars.set(name, { certain: true, origin: { uri, line: fn.lines[0] } });
    layer.loaded.add(uri);
    return layer;
  }

  #state(uri: string): FileAnalysis {
    let state = this.#files.get(uri);
    if (!state) {
      state = { runs: new Map(), stored: 0, contexts: new Map(), approximate: false };
      this.#files.set(uri, state);
    }
    return state;
  }

  #ctx(uri: string, file: FileSymbols, call: { entry?: string; via: string; probe: boolean; top: boolean; base: Layer }): Ctx {
    return { uri, file, fsPath: this.graph.fsPath(uri), entry: call.entry, via: call.via, top: call.top, base: call.base, probe: call.probe, collector: { reads: [], unresolved: [], needs: [] }, deps: { once: new Set(), constants: new Map() }, calls: new Set() };
  }

  /** Exécute le fichier `uri` par-dessus `layer` (modifiée : effet du fichier sur l'appelant). */
  /** Exécute le fichier `uri` par-dessus `layer` (modifiée : effet du fichier sur l'appelant) ; renvoie l'exécution. */
  #runFile(uri: string, layer: Layer, call: { entry?: string; via: string; probe: boolean; top: boolean }): Run | undefined {
    const file = this.#index.get(uri);
    if (!file?.flow) {
      layer.loaded.add(uri);
      return undefined;
    }
    if (this.#stack.includes(uri) || this.#stack.length >= MAX_DEPTH) return undefined;
    const state = this.#state(uri);
    const fp = layer.fingerprint();
    const variants = state.runs.get(fp) ?? [];
    let run = variants.find((candidate) => this.#reusable(candidate, layer));
    if (!run && state.union) run = state.union;
    if (!run) {
      const child = new Layer(layer);
      child.loaded.add(uri);
      for (const key of declarations(file).keys()) child.declared.set(key, uri);
      const ctx = this.#ctx(uri, file, { ...call, base: child });
      this.#stack.push(uri);
      try {
        this.#exec(file.flow.main, child, ctx);
      } finally {
        this.#stack.pop();
      }
      if (child.exit === 'return') child.exit = undefined;
      run = { ...ctx.collector, delta: child.delta(), deps: ctx.deps, calls: ctx.calls };
      if (!state.entry && !call.probe) state.entry = layer.flatten();
      if (!call.probe) {
        if (state.stored < this.#options.maxContexts) {
          state.runs.set(fp, [...variants, run]);
          state.stored++;
        } else {
          // Trop de contextes : les suivants partagent la réunion des exécutions (coût borné, règle stricte gardée)
          state.approximate = true;
          state.union = this.#union(state);
          run = state.union;
        }
      }
    }
    if (!call.probe) {
      const context = { run, missing: run.needs.filter((need) => !need.declaredIn.some((d) => layer.isLoaded(d))) };
      state.contexts.set(call.via, context);
      // Fonctions et classes déjà déclarées par un autre fichier de la chaîne (erreur fatale « Cannot redeclare »)
      for (const [key, declaredIn] of run.delta.declared) {
        const before = layer.declaredBy(key);
        if (!before || before === declaredIn) continue;
        const declaring = this.#index.get(declaredIn);
        const symbol = declaring && declarations(declaring).get(key);
        if (symbol) this.#duplicate(declaredIn, { name: symbol.name, other: before, range: symbol.selectionRange, via: call.via });
      }
      this.#pending?.push({ context, needs: this.#functions(uri).needs });
    }
    layer.apply(run.delta);
    // Autoloader enregistré par le fichier, même dans une fonction ou une méthode (PHPExcel_Autoloader::Register)
    if (this.#registersAutoload(uri, file)) layer.autoload = true;
    // Fichiers inclus par ses fonctions (chargement à la demande : connectDB(), loadModel()) : considérés chargés
    for (const target of this.#lazyTargets(uri, file)) layer.loaded.add(target);
    return run;
  }

  #duplicate(uri: string, entry: { name: string; other: string; range: Range; via: string }): void {
    const list = this.#duplicates.get(uri) ?? [];
    if (!list.some((d) => d.name === entry.name && d.via === entry.via && d.range.start.line === entry.range.start.line)) list.push(entry);
    this.#duplicates.set(uri, list);
  }

  /** Une exécution mémorisée vaut pour ce contexte si ce qu'elle a lu de l'appelant est identique. */
  #reusable(run: Run, layer: Layer): boolean {
    for (const target of run.deps.once) if (!layer.isLoaded(target)) return false;
    for (const [name, value] of run.deps.constants) if ((layer.constant(name) ?? this.graph.constant(name)) !== value) return false;
    return true;
  }

  /** Réunion des exécutions mémorisées : lectures et symboles de toutes, effet de la première. */
  #union(state: FileAnalysis): Run {
    const runs = [...state.runs.values()].flat();
    const reads = new Map<string, ReadIssue>();
    const needs = new Map<string, SymbolNeed>();
    const unresolved = new Map<number, UnresolvedInclude>();
    for (const run of runs) {
      for (const read of run.reads) {
        const key = `${read.at[0]}:${read.at[1]}`;
        if (!reads.has(key) || read.kind === 'undefined') reads.set(key, read);
      }
      for (const need of run.needs) needs.set(`${need.at[0]}:${need.at[1]}`, need);
      for (const u of run.unresolved) unresolved.set(u.index, u);
    }
    return { reads: [...reads.values()], needs: [...needs.values()], unresolved: [...unresolved.values()], delta: runs[0].delta, deps: { once: new Set(), constants: new Map() }, calls: new Set(runs.flatMap((r) => [...r.calls])) };
  }

  /** Cibles des includes situés dans les fonctions du fichier. */
  #lazyTargets(uri: string, file: FileSymbols): string[] {
    let targets = this.#lazy.get(uri);
    if (!targets) {
      const indexes: number[] = [];
      for (const fn of file.flow?.functions ?? []) walkOps(fn.body, (op) => op.op === 'include' && indexes.push(op.index));
      const sites = this.graph.sitesOf(uri);
      targets = indexes.map((i) => sites[i]?.target).filter((t): t is string => !!t);
      this.#lazy.set(uri, targets);
    }
    return targets;
  }


  #registersAutoload(uri: string, file: FileSymbols): boolean {
    let found = this.#autoloaders.get(uri);
    if (found === undefined) {
      found = false;
      for (const ops of [file.flow?.main ?? [], ...(file.flow?.functions ?? []).map((f) => f.body)]) {
        walkOps(ops, (op) => {
          if (op.op === 'autoload') found = true;
        });
      }
      this.#autoloaders.set(uri, found);
    }
    return found;
  }

  /** Fonctions du fichier, analysées une fois (portée propre : paramètres, `global`, `static`). */
  #functions(uri: string): Collector {
    const state = this.#state(uri);
    if (state.functions) return state.functions;
    const collector: Collector = { reads: [], unresolved: [], needs: [] };
    state.functions = collector;
    const file = this.#index.get(uri);
    for (const fn of file?.flow?.functions ?? []) {
      const layer = this.#functionLayer(uri, fn);
      const ctx = this.#ctx(uri, file!, { via: 'function', probe: true, top: false, base: layer });
      ctx.collector = collector;
      const before = collector.needs.length;
      this.#exec(fn.body, layer, ctx);
      for (const need of collector.needs.slice(before)) need.fn = fn.name;
    }
    return collector;
  }

  /** true : arrêt demandé (`until` atteint), l'état est dans `ctx.halt`. */
  #exec(ops: FlowOp[], layer: Layer, ctx: Ctx): boolean {
    for (const op of ops) {
      if (layer.exit) return false;
      if (ctx.until) {
        const at = this.#locOf(op, ctx);
        if (at && !before(at, ctx.until)) {
          ctx.halt = layer;
          return true;
        }
      }
      switch (op.op) {
        case 'assign': {
          if (op.guard) {
            layer.vars.set(op.name, { ...layer.get(op.name), certain: true });
          } else {
            const info: VarInfo = { certain: true, origin: { uri: ctx.uri, line: op.at[0] } };
            if (op.type) info.type = op.type;
            layer.vars.set(op.name, info);
          }
          break;
        }
        case 'read':
          this.#read(op.name, op.at, op.end, layer, ctx);
          break;
        case 'unset':
          layer.vars.set(op.name, null);
          break;
        case 'extract':
          if (op.source === 'request') layer.request = { from: op.from ?? '$_REQUEST', line: op.at[0] };
          else layer.stop = true;
          break;
        case 'dynamic':
          layer.stop = true;
          break;
        case 'exit':
          layer.exit = op.ret ? 'return' : 'exit';
          break;
        case 'define':
          if (layer.constant(op.name) === undefined) layer.constants.set(op.name, evaluatePath(op.value, this.#env(ctx, layer)));
          break;
        case 'autoload':
          layer.autoload = true;
          break;
        case 'call':
          for (const arg of op.args) {
            if (this.#byRef(op, arg.index)) layer.vars.set(arg.name, { certain: true, origin: { uri: ctx.uri, line: arg.at[0] } });
            else if (!op.quiet) this.#read(arg.name, arg.at, arg.end, layer, ctx);
          }
          break;
        case 'use':
          this.#use(op, layer, ctx);
          break;
        case 'include':
          this.#include(op.index, layer, ctx);
          break;
        case 'branch': {
          const alts: Layer[] = [];
          for (const branch of op.alts) {
            const alt = new Layer(layer);
            if (this.#exec(branch, alt, ctx)) return true;
            alts.push(alt);
          }
          merge(layer, alts, op.exhaustive);
          break;
        }
        case 'loop': {
          const body = new Layer(layer);
          if (this.#exec(op.body, body, ctx)) return true;
          merge(layer, [body], false);
          break;
        }
      }
    }
    return false;
  }

  #locOf(op: FlowOp, ctx: Ctx): Loc | undefined {
    switch (op.op) {
      case 'assign':
      case 'read':
      case 'extract':
      case 'dynamic':
      case 'use':
        return op.at;
      case 'call':
        return op.args[0]?.at;
      case 'include': {
        const start = ctx.file.includes[op.index]?.range.start;
        return start && [start.line, start.character];
      }
      default:
        return undefined;
    }
  }

  #read(name: string, at: Loc, end: number, layer: Layer, ctx: Ctx): void {
    if (layer.stop) return;
    const info = layer.get(name);
    if (info?.certain) return;
    if (!info && layer.request) return;
    ctx.collector.reads.push({ name, at, end, kind: info ? 'maybe' : 'undefined' });
  }

  #env(ctx: Ctx, layer: Layer): ResolveEnv {
    return this.graph.env(ctx.fsPath, ctx.entry, (name) => {
      const own = layer.ownConstant(name, ctx.base.parent);
      if (own) return own.value ?? this.graph.constant(name);
      // Constante de l'appelant : dépendance de l'exécution
      const value = ctx.base.parent?.constant(name) ?? this.graph.constant(name);
      ctx.deps.constants.set(name, value);
      return value;
    });
  }

  #include(index: number, layer: Layer, ctx: Ctx): void {
    const ref = ctx.file.includes[index];
    if (!ref) return;
    const targets = resolveInclude(ref.path, this.#env(ctx, layer));
    if (!targets?.length) {
      ctx.collector.unresolved.push({ index, evaluated: targets !== undefined });
      layer.stop = true;
      return;
    }
    const target = this.graph.uriOf(targets[0]);
    // Fichier inclus une seconde fois sans _once : ses fonctions et classes sont redéclarées (erreur fatale)
    if (!ref.kind.endsWith('_once') && layer.isLoaded(target) && !ctx.probe) {
      const included = this.#index.get(target);
      if (included && declarations(included).size) this.#duplicate(ctx.uri, { name: fileName(target), other: target, range: ref.range, via: ctx.via });
    }
    if (ref.kind.endsWith('_once') && layer.isLoaded(target)) {
      // Sauté grâce à l'appelant : l'exécution en dépend
      if (!layer.isLoaded(target, ctx.base.parent)) ctx.deps.once.add(target);
      return;
    }
    const via = ctx.top ? `${ctx.uri}#${ref.range.start.line}` : ctx.via;
    const run = this.#runFile(target, layer, { entry: ctx.entry, via, probe: ctx.probe, top: false });
    // Dépendances du fichier inclus qui ne sont pas satisfaites par ce fichier-ci : remontées à l'appelant
    for (const once of run?.deps.once ?? []) if (!layer.isLoaded(once, ctx.base.parent)) ctx.deps.once.add(once);
    for (const [name, value] of run?.deps.constants ?? []) if (!layer.ownConstant(name, ctx.base.parent)) ctx.deps.constants.set(name, value);
    for (const name of run?.calls ?? []) ctx.calls.add(name);
  }

  #use(op: Extract<FlowOp, { op: 'use' }>, layer: Layer, ctx: Ctx): void {
    if (op.kind === 'function') ctx.calls.add(shortName(op.names[0] ?? ''));
    // Contexte inconnu (include non résolu, gabarit dynamique, code dynamique) : le symbole a pu être chargé
    if (layer.stop || (op.kind === 'class' && layer.autoload)) return;
    const declared = this.#declaredIn(op.kind, op.names);
    if (!declared.length || declared.includes(ctx.uri)) return;
    // Chargé par le fichier lui-même (au-dessus de sa couche de départ) : satisfait dans tous les contextes
    if (declared.some((d) => layer.isLoaded(d, ctx.base.parent))) return;
    ctx.collector.needs.push({ kind: op.kind, name: op.names[0], declaredIn: declared, at: op.at, end: op.end });
  }

  /** Fichiers du workspace qui déclarent le symbole (hors classes chargées automatiquement). */
  #declaredIn(kind: SymbolNeed['kind'], names: string[]): string[] {
    const key = `${kind}:${names.join('|')}`;
    let out = this.#declared.get(key);
    if (!out) {
      const hits = names.flatMap((name) => (kind === 'function' ? this.#index.findFunction(name) : kind === 'class' ? this.#index.findClass(name) : this.#index.findConstant(name)));
      // Classes chargées automatiquement, fichiers d'un dossier inclus dynamiquement : chargés sans include visible
      out = [...new Set(hits.map((hit) => hit.uri))].filter((uri) => !this.graph.isAutoloaded(uri) && !this.graph.isDynamicTarget(uri));
      this.#declared.set(key, out);
    }
    return out;
  }

  /** Le paramètre `index` de l'appelé est-il par référence ? Fonction inconnue : on suppose que oui (pas d'alerte). */
  #byRef(op: Extract<FlowOp, { op: 'call' }>, index: number): boolean {
    if (op.method) return this.#methodRefs_().get(op.method.toLowerCase())?.has(index) ?? false;
    if (!op.names.length) return false;
    for (const name of op.names) {
      const hit = this.#lookup.findFunction(name)[0];
      if (hit) return paramByRef(hit.symbol.params, index);
    }
    return true;
  }

  /** Méthodes (workspace et stubs) : rangs de leurs paramètres par référence, par nom en minuscules. */
  #methodRefs_(): Map<string, Set<number>> {
    if (this.#methodRefs) return this.#methodRefs;
    const out = new Map<string, Set<number>>();
    for (const index of [this.#lookup.workspace, this.#lookup.stubs]) {
      for (const file of index.files()) {
        for (const symbol of file.symbols) {
          for (const member of symbol.children ?? []) {
            if (member.kind !== 'method' || !member.params?.some((p) => p.byRef)) continue;
            const set = out.get(member.name.toLowerCase()) ?? new Set<number>();
            member.params.forEach((param, i) => {
              if (!param.byRef) return;
              set.add(i);
              if (param.variadic) for (let j = i + 1; j < i + 16; j++) set.add(j);
            });
            out.set(member.name.toLowerCase(), set);
          }
        }
      }
    }
    this.#methodRefs = out;
    return out;
  }
}
