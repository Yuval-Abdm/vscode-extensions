// Résolution des chemins d'include (§4.2) : évaluation de l'expression symbolique avec les constantes connues,
// puis recherche du fichier comme PHP — chemin absolu (ou racine du serveur ramenée à la racine locale),
// relatif au script d'entrée, puis au fichier appelant, puis aux racines du workspace.
import path from 'node:path';
import type { PathExpr } from '../../shared/types.ts';

export interface PathEnv {
  /** Fichier qui contient l'expression (chemin absolu) */
  file: string;
  /** Script d'entrée de la chaîne d'appel, s'il est connu */
  entry?: string;
  /** Valeur d'une constante, déjà évaluée */
  constant: (name: string) => string | undefined;
  /** `$_SERVER['DOCUMENT_ROOT']` */
  docroot: string;
}

export interface ResolveEnv extends PathEnv {
  exists: (fsPath: string) => boolean;
  /** Racines du serveur et leur équivalent local (`phpForge.serverRoot`, `remotePath` de deploy.json) */
  serverRoots: { remote: string; local: string }[];
  /** Racines du workspace : dernier recours des chemins relatifs */
  roots: string[];
}

const MAX_DEPTH = 12;

export function evaluatePath(expr: PathExpr, env: PathEnv, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  switch (expr.k) {
    case 'lit':
      return expr.v;
    case 'dir':
      return path.dirname(env.file);
    case 'file':
      return env.file;
    case 'docroot':
      return env.docroot;
    case 'const':
      return env.constant(expr.name);
    case 'cat': {
      let out = '';
      for (const part of expr.parts) {
        const value = evaluatePath(part, env, depth + 1);
        if (value === undefined) return undefined;
        out += value;
      }
      return out;
    }
    case 'dirname': {
      let value = evaluatePath(expr.of, env, depth + 1);
      if (value === undefined) return undefined;
      for (let i = 0; i < expr.levels; i++) value = path.dirname(value);
      return value;
    }
    default:
      return undefined;
  }
}

/** Partie connue au début d'une concaténation (« /var/www/templates/ » pour ROOT_PATH.'/templates/'.$page). */
export function evaluatePrefix(expr: PathExpr, env: PathEnv): string | undefined {
  if (expr.k !== 'cat') return undefined;
  let out = '';
  for (const part of expr.parts) {
    const value = evaluatePath(part, env);
    if (value === undefined) break;
    out += value;
  }
  return out || undefined;
}

/** Chemins possibles pour une valeur, dans l'ordre de PHP. */
function candidates(value: string, env: ResolveEnv): string[] {
  if (path.isAbsolute(value)) {
    const out = [path.normalize(value)];
    for (const { remote, local } of env.serverRoots) {
      const relative = path.relative(remote, value);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) out.push(path.join(local, relative));
    }
    return out;
  }
  const dirs = [env.entry ? path.dirname(env.entry) : undefined, path.dirname(env.file), ...env.roots].filter((d): d is string => !!d);
  return [...new Set(dirs.map((dir) => path.resolve(dir, value)))];
}

/** Fichier inclus : undefined si le chemin n'est pas évaluable (dynamique), `[]` s'il est évalué mais introuvable. */
export function resolveInclude(expr: PathExpr, env: ResolveEnv): string[] | undefined {
  const value = evaluatePath(expr, env);
  if (value === undefined || value === '') return undefined;
  const found = candidates(value, env).find((c) => env.exists(c));
  return found ? [found] : [];
}

/** Dossiers où peuvent se trouver les fichiers d'un include dynamique (préfixe connu jusqu'au dernier « / »). */
export function dynamicDirs(expr: PathExpr, env: ResolveEnv): string[] {
  const prefix = evaluatePrefix(expr, env);
  const slash = prefix?.lastIndexOf('/') ?? -1;
  if (!prefix || slash < 0) return [];
  return candidates(prefix.slice(0, slash + 1), env).map((dir) => (dir.endsWith(path.sep) ? dir : dir + path.sep));
}
