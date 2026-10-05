// Impact d'une modification (§5.9) : pour chaque fichier modifié, les scripts d'entrée (pages que personne n'inclut) qui
// l'atteignent par inclusion — la liste des pages à vérifier avant ou après un déploiement.
import type { ImpactEntry } from '../../shared/protocol.ts';
import { relativePath } from './diagnostics.ts';
import type { IncludeGraph } from './graph.ts';

/** Fichiers modifiés connus du graphe, triés par chemin ; les autres (CSS, fichiers hors workspace) sont ignorés. */
export function impactOf(graph: IncludeGraph, uris: string[]): ImpactEntry[] {
  const known = new Set(graph.files());
  return [...new Set(uris)]
    .filter((uri) => known.has(uri))
    .map((uri) => {
      const pages = new Set<string>();
      let approximate = false;
      const seen = new Set([uri]);
      const queue = [uri];
      while (queue.length) {
        const current = queue.shift()!;
        // Gabarit inclus par un chemin dynamique : ses appelants ne sont pas tous connus
        if (graph.isDynamicTarget(current)) approximate = true;
        const includers = graph.includersOf(current).map((site) => site.from).filter((from) => from !== current);
        if (!includers.length) pages.add(current);
        for (const from of includers) {
          if (seen.has(from)) continue;
          seen.add(from);
          queue.push(from);
        }
      }
      // Gabarit dynamique sans appelant connu : ce n'est pas une page
      if (approximate) pages.delete(uri);
      const list = [...pages].map((page) => ({ uri: page, label: relativePath(graph, page) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      return { uri, label: relativePath(graph, uri), pages: list, approximate };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
