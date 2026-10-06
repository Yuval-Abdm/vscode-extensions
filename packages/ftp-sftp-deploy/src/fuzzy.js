// @ts-check
// Recherche floue de fichiers, comme « Aller au fichier » de VS Code : les lettres tapées apparaissent dans l'ordre
// dans le chemin, pas forcément côte à côte (« usctl » trouve « src/user/UserController.php »). Plusieurs mots
// séparés par des espaces doivent tous correspondre. Aucune dépendance à vscode.

const SEPARATORS = '/\\._- ';

/**
 * Score d'un mot de la recherche dans un chemin, ou null s'il ne correspond pas. Favorise le nom du fichier, les
 * lettres consécutives et les débuts de mots (après « / », « . », « _ », « - » ou une majuscule).
 * @param {string} query mot en minuscules, sans espace
 * @param {string} target chemin
 */
function scoreWord(query, target) {
  const lower = target.toLowerCase();
  const nameStart = target.lastIndexOf('/') + 1;
  // Correspondance la plus à droite possible : on cherche d'abord dans le nom du fichier.
  let best = null;
  for (const from of nameStart > 0 ? [nameStart, 0] : [0]) {
    const score = scoreFrom(query, target, lower, from, nameStart);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

function scoreFrom(query, target, lower, from, nameStart) {
  let score = 0;
  let previous = -2;
  let index = from;
  for (const char of query) {
    const found = lower.indexOf(char, index);
    if (found === -1) return null;
    let points = 1;
    if (found === previous + 1) points += 5;
    const before = target[found - 1];
    if (found === 0 || SEPARATORS.includes(before) || (target[found] !== lower[found] && before === before.toLowerCase())) points += 4;
    if (found >= nameStart) points += 2;
    score += points;
    previous = found;
    index = found + 1;
  }
  // Une correspondance exacte du nom du fichier passe en tête ; les chemins courts sont préférés.
  if (target.slice(nameStart).toLowerCase().startsWith(query)) score += 10;
  return score - target.length / 100;
}

/**
 * Chemins correspondant à la recherche, du plus pertinent au moins pertinent.
 * @param {string} query
 * @param {readonly string[]} paths
 * @param {number} [limit]
 * @returns {string[]}
 */
function fuzzyFilter(query, paths, limit = 200) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return paths.slice(0, limit);
  /** @type {{ path: string, score: number }[]} */
  const matches = [];
  for (const p of paths) {
    let total = 0;
    for (const word of words) {
      const score = scoreWord(word, p);
      if (score === null) {
        total = -Infinity;
        break;
      }
      total += score;
    }
    if (total !== -Infinity) matches.push({ path: p, score: total });
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return matches.slice(0, limit).map((m) => m.path);
}

module.exports = { fuzzyFilter, scoreWord };
