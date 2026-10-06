// @ts-check
// Recherche floue de fichiers, comme « Aller au fichier » de VS Code : les lettres tapées apparaissent dans l'ordre
// dans le chemin, pas forcément côte à côte (« usctl » trouve « src/user/UserController.php »). Plusieurs mots
// séparés par des espaces doivent tous correspondre. Aucune dépendance à vscode.

const SEPARATORS = '/\\._- ';

/**
 * Correspondance d'un mot de la recherche dans un chemin, ou null. Favorise le nom du fichier, les lettres
 * consécutives et les débuts de mots (après « / », « . », « _ », « - » ou une majuscule).
 * @param {string} query mot en minuscules, sans espace
 * @param {string} target chemin
 * @returns {{ score: number, positions: number[] } | null}
 */
function matchWord(query, target) {
  const lower = target.toLowerCase();
  const nameStart = target.lastIndexOf('/') + 1;
  // On cherche d'abord dans le nom du fichier, puis dans tout le chemin ; la meilleure correspondance l'emporte.
  let best = null;
  for (const from of nameStart > 0 ? [nameStart, 0] : [0]) {
    const match = matchFrom(query, target, lower, from, nameStart);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

function matchFrom(query, target, lower, from, nameStart) {
  let score = 0;
  let previous = -2;
  let index = from;
  const positions = [];
  for (const char of query) {
    const found = lower.indexOf(char, index);
    if (found === -1) return null;
    let points = 1;
    if (found === previous + 1) points += 5;
    const before = target[found - 1];
    if (found === 0 || SEPARATORS.includes(before) || (target[found] !== lower[found] && before === before.toLowerCase())) points += 4;
    if (found >= nameStart) points += 2;
    score += points;
    positions.push(found);
    previous = found;
    index = found + 1;
  }
  // Un nom de fichier qui commence par la recherche passe en tête ; les chemins courts sont préférés.
  if (target.slice(nameStart).toLowerCase().startsWith(query)) score += 10;
  return { score: score - target.length / 100, positions };
}

/**
 * Chemins correspondant à la recherche, du plus pertinent au moins pertinent, avec les positions des lettres trouvées.
 * @param {string} query
 * @param {readonly string[]} paths
 * @param {number} [limit]
 * @returns {{ path: string, positions: number[] }[]}
 */
function fuzzyMatch(query, paths, limit = 200) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return paths.slice(0, limit).map((p) => ({ path: p, positions: [] }));
  /** @type {{ path: string, positions: number[], score: number }[]} */
  const matches = [];
  for (const p of paths) {
    let score = 0;
    const positions = new Set();
    for (const word of words) {
      const match = matchWord(word, p);
      if (!match) {
        score = -Infinity;
        break;
      }
      score += match.score;
      match.positions.forEach((i) => positions.add(i));
    }
    if (score !== -Infinity) matches.push({ path: p, positions: [...positions].sort((a, b) => a - b), score });
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return matches.slice(0, limit).map(({ path, positions }) => ({ path, positions }));
}

/** Chemins seuls (voir fuzzyMatch). @param {string} query @param {readonly string[]} paths @param {number} [limit] */
function fuzzyFilter(query, paths, limit) {
  return fuzzyMatch(query, paths, limit).map((m) => m.path);
}

module.exports = { fuzzyFilter, fuzzyMatch };
