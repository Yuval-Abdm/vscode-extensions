// Fichiers PHP d'un dossier : extensions reconnues, dossiers exclus (globs) ou toujours ignorés, liens symboliques sautés.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Minimatch } from 'minimatch';

export const PHP_EXTENSIONS = ['.php', '.php4', '.php5', '.phtml', '.ctp'];
const ALWAYS_SKIPPED = new Set(['.git', '.svn', '.hg', 'node_modules', '.vscode-test']);

/** Teste un chemin relatif (séparateur « / ») contre les globs d'exclusion ; un dossier est testé aussi avec « / » final. */
function excluder(exclude: string[]): (rel: string, isDirectory: boolean) => boolean {
  const matchers = exclude.map((glob) => new Minimatch(glob, { dot: true, nocase: true }));
  return (rel, isDirectory) => matchers.some((m) => m.match(rel) || (isDirectory && m.match(`${rel}/`)));
}

export async function listPhpFiles(root: string, exclude: string[] = []): Promise<string[]> {
  const excluded = excluder(exclude);
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!ALWAYS_SKIPPED.has(entry.name) && !excluded(rel, true)) await walk(full);
      } else if (entry.isFile() && PHP_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()) && !excluded(rel, false)) {
        out.push(full);
      }
    }
  };
  await walk(root);
  return out.sort();
}

/** Le fichier fait-il partie de l'index du dossier `root` (événements du système de fichiers) ? */
export function isIndexable(root: string, filePath: string, exclude: string[]): boolean {
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.some((part) => ALWAYS_SKIPPED.has(part))) return false;
  if (!PHP_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) return false;
  // Mêmes règles que le parcours : chaque dossier parent, puis le fichier
  const excluded = excluder(exclude);
  for (let i = 1; i < parts.length; i++) if (excluded(parts.slice(0, i).join('/'), true)) return false;
  return !excluded(parts.join('/'), false);
}
