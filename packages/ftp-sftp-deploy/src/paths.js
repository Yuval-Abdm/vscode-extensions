// @ts-check
// Correspondance chemins locaux ↔ distants et règles d'exclusion. Aucune dépendance à vscode.
const path = require('path');
const { minimatch } = require('minimatch');

const DEFAULT_IGNORE = ['.git', '.vscode', '.DS_Store', 'node_modules'];

/** Chemin relatif POSIX d'un fichier local dans son dossier racine, ou null s'il est en dehors. */
function relativeLocal(rootFsPath, fsPath) {
  const rel = path.relative(rootFsPath, fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Chemin distant absolu correspondant à un chemin relatif. */
function toRemote(remoteRoot, rel) {
  return path.posix.join(normalizeRemote(remoteRoot), rel || '.');
}

/** Chemin relatif d'un chemin distant sous la racine distante, ou null s'il est en dehors. */
function relativeRemote(remoteRoot, remotePath) {
  const rel = path.posix.relative(normalizeRemote(remoteRoot), normalizeRemote(remotePath));
  if (rel.startsWith('..')) return null;
  return rel;
}

function normalizeRemote(p) {
  const n = path.posix.normalize('/' + (p || '/'));
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/**
 * Un motif sans « / » s'applique à n'importe quel segment du chemin (« node_modules », « *.log »),
 * sinon au chemin relatif complet (« dist/** », « config/secret.php »).
 * @param {string} rel chemin relatif POSIX
 * @param {string[]} patterns
 */
function isIgnored(rel, patterns) {
  if (!rel) return false;
  const segments = rel.split('/');
  return patterns.some((p) => {
    const pattern = p.replace(/^\/+|\/+$/g, '');
    if (!pattern) return false;
    if (!pattern.includes('/')) return segments.some((s) => minimatch(s, pattern, { dot: true }));
    return minimatch(rel, pattern, { dot: true }) || rel.startsWith(pattern + '/');
  });
}

module.exports = { DEFAULT_IGNORE, relativeLocal, toRemote, relativeRemote, normalizeRemote, isIgnored };
