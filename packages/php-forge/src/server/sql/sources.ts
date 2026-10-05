// Sources du schéma SQL du workspace : fichiers .sql des globs `phpForge.sql.schema` (relatifs à chaque dossier) et
// cache de la base (`.vscode/php-forge-schema.json`, écrit par la commande « Refresh SQL schema »). Relu en entier
// quand l'une d'elles change : quelques dizaines de fichiers, lus en quelques millisecondes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { URI } from 'vscode-uri';
import { parseSqlFile, Schema, type SchemaCache } from './schema.ts';

export const SCHEMA_CACHE = '.vscode/php-forge-schema.json';
/** Au-delà, un fichier .sql est un dump de données : ignoré */
const MAX_SQL_FILE = 20_000_000;
/** Volume total lu par chargement (dossier de sauvegardes quotidiennes, par exemple) */
const MAX_SQL_TOTAL = 100_000_000;

export interface SchemaSources {
  folders: string[];
  globs: string[];
  exclude: string[];
  maxSize?: number;
  maxTotal?: number;
}

export interface SchemaLoad {
  schema: Schema;
  /** Fichiers lus (.sql et caches) */
  files: number;
  /** Fichiers ignorés et pourquoi (journal du serveur) */
  errors: string[];
}

const options = { dot: true, nocase: true };

function included(rel: string, sources: SchemaSources): boolean {
  return sources.globs.some((g) => minimatch(rel, g, options)) && !sources.exclude.some((g) => minimatch(rel, g, options));
}

/** Chemin relatif au dossier (séparateur « / »), ou undefined hors du dossier. */
function relative(folder: string, fsPath: string): string | undefined {
  const rel = path.relative(folder, fsPath);
  return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
}

/** Fichier qui alimente le schéma : .sql d'un glob, ou cache de la base. */
export function isSchemaSource(fsPath: string, sources: SchemaSources): boolean {
  return sources.folders.some((folder) => {
    const rel = relative(folder, fsPath);
    return rel !== undefined && (rel === SCHEMA_CACHE || (rel.toLowerCase().endsWith('.sql') && included(rel, sources)));
  });
}

/** Dossiers à parcourir : partie fixe de chaque glob (« sql/…/*.sql » → « sql »), sans doublon ni sous-dossier d'un autre ; « » : tout le dossier. */
export function globRoots(globs: string[]): string[] {
  const roots = globs.map((g) => {
    const fixed: string[] = [];
    for (const part of g.split('/').slice(0, -1)) {
      if (/[*?[\]{}!]/.test(part)) break;
      fixed.push(part);
    }
    return fixed.join('/');
  });
  if (roots.includes('')) return [''];
  return [...new Set(roots)].sort().filter((r, i, all) => !all.slice(0, i).some((p) => r.startsWith(`${p}/`)));
}

/** Fichiers .sql d'un dossier qui correspondent aux globs (seulement sous leurs parties fixes, dossiers exclus jamais parcourus), triés. */
function sqlFiles(folder: string, sources: SchemaSources): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!sources.exclude.some((g) => minimatch(`${child}/x`, g, options))) walk(path.join(dir, entry.name), child);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql') && included(child, sources)) {
        out.push(child);
      }
    }
  };
  for (const root of globRoots(sources.globs)) walk(path.join(folder, root), root);
  return out.sort();
}

export function loadSchema(sources: SchemaSources): SchemaLoad {
  const schema = new Schema();
  const errors: string[] = [];
  let files = 0;
  const max = sources.maxSize ?? MAX_SQL_FILE;
  const maxTotal = sources.maxTotal ?? MAX_SQL_TOTAL;
  let total = 0;
  for (const folder of sources.folders) {
    for (const rel of sqlFiles(folder, sources)) {
      const fsPath = path.join(folder, rel);
      try {
        const size = statSync(fsPath).size;
        if (size > max) {
          errors.push(`${rel}: larger than ${max} bytes, ignored`);
          continue;
        }
        if (total + size > maxTotal) {
          errors.push(`${rel}: more than ${maxTotal} bytes of .sql files in total, ignored`);
          continue;
        }
        total += size;
        schema.add(parseSqlFile(readFileSync(fsPath, 'utf8'), URI.file(fsPath).toString()));
        files++;
      } catch (err) {
        errors.push(`${rel}: ${String(err)}`);
      }
    }
    const cache = path.join(folder, SCHEMA_CACHE);
    if (!existsSync(cache)) continue;
    try {
      const content = JSON.parse(readFileSync(cache, 'utf8')) as SchemaCache;
      schema.addCache(content, URI.file(cache).toString());
      files++;
    } catch (err) {
      errors.push(`${SCHEMA_CACHE}: ${String(err)}`);
    }
  }
  return { schema, files, errors };
}
