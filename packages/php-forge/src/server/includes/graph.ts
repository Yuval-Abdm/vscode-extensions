// Graphe d'inclusion (§4.3) : cibles de chaque include résolues hors chaîne d'appel (constantes globales, dossier
// du fichier, racines du workspace), appelants, scripts d'entrée (fichiers que personne n'inclut), dossiers inclus
// par un chemin dynamique (gabarits), autoload Composer, racines du serveur (serverRoot, deploy.json).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { URI } from 'vscode-uri';
import type { FileSymbols, FlowOp } from '../../shared/types.ts';
import type { SymbolIndex } from '../index/symbolIndex.ts';
import { dynamicDirs, evaluatePath, resolveInclude, type ResolveEnv } from './resolve.ts';

export interface GraphOptions {
  /** Racines du workspace (chemins absolus) */
  roots: string[];
  /** `phpForge.documentRoot` : absolu ou relatif à la première racine ; vide : la première racine */
  documentRoot?: string;
  /** `phpForge.serverRoot` : chemin absolu sur le serveur qui correspond à la première racine */
  serverRoot?: string;
  /** Lecture d'un fichier de configuration (tests) */
  readFile?: (fsPath: string) => string | undefined;
}

export interface IncludeSite {
  /** Fichier qui contient l'include */
  from: string;
  /** Rang de l'include dans le fichier */
  index: number;
  line: number;
  /** Fichier inclus, s'il est trouvé */
  target?: string;
  /** Chemin évalué (le fichier peut être introuvable) */
  evaluated: boolean;
}

type ServerRoot = { remote: string; local: string };

function readText(fsPath: string): string | undefined {
  try {
    return readFileSync(fsPath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Parcours de toutes les opérations, branches et boucles comprises. */
export function walkOps(ops: FlowOp[], visit: (op: FlowOp) => void): void {
  for (const op of ops) {
    visit(op);
    if (op.op === 'branch') for (const alt of op.alts) walkOps(alt, visit);
    else if (op.op === 'loop') walkOps(op.body, visit);
  }
}

const withSep = (dir: string) => (dir.endsWith(path.sep) ? dir : dir + path.sep);

export class IncludeGraph {
  readonly roots: string[];
  readonly docroot: string;
  readonly serverRoots: ServerRoot[];
  /** Fichiers chargés par Composer (`autoload.files`) : toujours chargés */
  readonly alwaysLoaded = new Set<string>();
  readonly #uris = new Map<string, string>();
  readonly #paths = new Map<string, string>();
  readonly #sites = new Map<string, IncludeSite[]>();
  readonly #includers = new Map<string, IncludeSite[]>();
  readonly #constants = new Map<string, string>();
  readonly #dynamicDirs = new Set<string>();
  readonly #autoloadDirs: string[] = [];

  constructor(index: SymbolIndex, options: GraphOptions) {
    const read = options.readFile ?? readText;
    this.roots = options.roots;
    const first = options.roots[0] ?? path.sep;
    this.docroot = options.documentRoot ? path.resolve(first, options.documentRoot) : first;
    this.serverRoots = serverRoots(options, read);
    const files = [...index.files()].filter((f) => f.flow);
    for (const file of files) {
      const fsPath = URI.parse(file.uri).fsPath;
      this.#uris.set(fsPath, file.uri);
      this.#paths.set(file.uri, fsPath);
    }
    this.#collectConstants(files);
    for (const root of options.roots) this.#composer(root, read);
    for (const file of files) this.#link(file);
  }

  get size(): number {
    return this.#paths.size;
  }

  fsPath(uri: string): string {
    return this.#paths.get(uri) ?? URI.parse(uri).fsPath;
  }

  uriOf(fsPath: string): string {
    return this.#uris.get(fsPath) ?? URI.file(fsPath).toString();
  }

  has(fsPath: string): boolean {
    return this.#uris.has(fsPath);
  }

  constant(name: string): string | undefined {
    return this.#constants.get(name);
  }

  sitesOf(uri: string): IncludeSite[] {
    return this.#sites.get(uri) ?? [];
  }

  includersOf(uri: string): IncludeSite[] {
    return this.#includers.get(uri) ?? [];
  }

  /** Tous les fichiers qui ont un programme. */
  files(): string[] {
    return [...this.#paths.keys()];
  }

  /** Scripts d'entrée : fichiers que personne d'autre n'inclut. */
  entries(): string[] {
    return [...this.#paths.keys()].filter((uri) => !this.includersOf(uri).some((site) => site.from !== uri));
  }

  /** Fichier d'un dossier inclus par un chemin dynamique (gabarit) : jamais analysé comme un script autonome. */
  isDynamicTarget(uri: string): boolean {
    const fsPath = this.fsPath(uri);
    for (const dir of this.#dynamicDirs) if (fsPath.startsWith(dir)) return true;
    return false;
  }

  /** Classe chargée automatiquement (autoload Composer, dossier vendor) : pas besoin d'include. */
  isAutoloaded(uri: string): boolean {
    const fsPath = this.fsPath(uri);
    return fsPath.includes(`${path.sep}vendor${path.sep}`) || this.#autoloadDirs.some((dir) => fsPath.startsWith(dir));
  }

  env(fsPath: string, entry?: string, constant?: (name: string) => string | undefined): ResolveEnv {
    return {
      file: fsPath,
      entry,
      docroot: this.docroot,
      serverRoots: this.serverRoots,
      roots: this.roots,
      constant: constant ?? ((name) => this.#constants.get(name)),
      exists: (p) => this.#uris.has(p),
    };
  }

  #link(file: FileSymbols): void {
    const env = this.env(this.fsPath(file.uri));
    const sites = file.includes.map((ref, index): IncludeSite => {
      const targets = resolveInclude(ref.path, env);
      const site: IncludeSite = { from: file.uri, index, line: ref.range.start.line, evaluated: targets !== undefined };
      if (targets?.length) {
        site.target = this.uriOf(targets[0]);
        const list = this.#includers.get(site.target);
        if (list) list.push(site);
        else this.#includers.set(site.target, [site]);
      } else {
        // Préfixe connu réduit à une racine (routeur `DOCUMENT_ROOT.'/'.$page`) : ce n'est pas un dossier de gabarits
        for (const dir of dynamicDirs(ref.path, env)) if (!this.#isRootish(dir)) this.#dynamicDirs.add(dir);
      }
      return site;
    });
    this.#sites.set(file.uri, sites);
  }

  /** Dossier qui est une racine du workspace, la racine web, ou un de leurs parents. */
  #isRootish(dir: string): boolean {
    return [...this.roots, this.docroot].some((root) => withSep(root).startsWith(dir));
  }

  /** Constantes de chemin (define / const) dont toutes les définitions donnent la même valeur. */
  #collectConstants(files: FileSymbols[]): void {
    // Deux passes : une constante peut être définie à partir d'une autre
    for (let pass = 0; pass < 2; pass++) {
      const values = new Map<string, Set<string>>();
      for (const file of files) {
        const env = this.env(this.fsPath(file.uri));
        walkOps(file.flow!.main, (op) => {
          if (op.op !== 'define') return;
          const value = evaluatePath(op.value, env);
          if (value === undefined) return;
          const set = values.get(op.name);
          if (set) set.add(value);
          else values.set(op.name, new Set([value]));
        });
      }
      for (const [name, set] of values) if (set.size === 1) this.#constants.set(name, [...set][0]);
    }
  }

  #composer(root: string, read: (fsPath: string) => string | undefined): void {
    const text = read(path.join(root, 'composer.json'));
    if (!text) return;
    let json: Record<string, Record<string, unknown> | undefined>;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    for (const section of [json.autoload, json['autoload-dev']]) {
      if (!section) continue;
      for (const kind of ['psr-4', 'psr-0']) {
        for (const dirs of Object.values((section[kind] ?? {}) as Record<string, string | string[]>)) {
          for (const dir of [dirs].flat()) this.#autoloadDirs.push(withSep(path.resolve(root, dir)));
        }
      }
      for (const entry of (section.classmap ?? []) as string[]) this.#autoloadDirs.push(path.resolve(root, entry));
      for (const file of (section.files ?? []) as string[]) this.alwaysLoaded.add(this.uriOf(path.resolve(root, file)));
    }
  }
}

function serverRoots(options: GraphOptions, read: (fsPath: string) => string | undefined): ServerRoot[] {
  const out: ServerRoot[] = [];
  const first = options.roots[0];
  if (options.serverRoot && first) out.push({ remote: options.serverRoot, local: first });
  for (const root of options.roots) {
    const text = read(path.join(root, '.vscode', 'deploy.json'));
    if (!text) continue;
    try {
      const json = JSON.parse(stripJsonc(text)) as { profiles?: Record<string, { remotePath?: unknown }> };
      for (const profile of Object.values(json.profiles ?? {})) {
        const remote = profile?.remotePath;
        if (typeof remote === 'string' && remote.startsWith('/') && remote !== '/') out.push({ remote, local: root });
      }
    } catch {
      // deploy.json invalide : ignoré (l'extension FTP SFTP Deploy le signale)
    }
  }
  return out;
}

/** JSON avec commentaires et virgules finales (deploy.json). */
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
