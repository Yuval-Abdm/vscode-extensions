// Placement du graphe des commits (sans dépendance à VS Code). Les commits arrivent enfants avant parents ; chaque
// colonne (« voie ») attend un commit précis. Pour chaque ligne : colonne du commit, segments entrants (du haut de la
// ligne vers le milieu) et sortants (du milieu vers le bas), avec la couleur de leur voie. Chaque voie a sa couleur
// (jamais réutilisée) et, quand on peut le savoir, le nom de sa branche : affiché au survol du graphe.

export interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  column: number;
  color: number;
  up: Edge[];
  down: Edge[];
  /** Nombre de colonnes occupées sur cette ligne. */
  width: number;
  /** Noms de branche appris sur cette ligne, par couleur de voie. */
  names?: Record<number, string>;
}

interface Lane {
  sha: string;
  color: number;
  name?: string;
}

export interface LayoutCommit {
  sha: string;
  parents: readonly string[];
  refs?: readonly { name: string; kind: string }[];
  summary?: string;
}

/** Branche portée par un commit : locale de préférence, sinon distante (les tags ne nomment pas de voie). */
function branchOf(commit: LayoutCommit): string | undefined {
  const refs = commit.refs ?? [];
  return (refs.find((ref) => ref.kind === 'branch') ?? refs.find((ref) => ref.kind === 'remote'))?.name;
}

/** Branche mergée, d'après le message de merge de git ou de GitHub. */
export function mergedBranch(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const git = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(summary);
  if (git) return git[1];
  const pullRequest = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(summary);
  return pullRequest?.[1];
}

export class GraphLayout {
  /** Voies ouvertes : commit attendu par colonne (null : colonne libre). */
  #lanes: (Lane | null)[] = [];
  #nextColor = 0;

  add(commits: readonly LayoutCommit[]): GraphRow[] {
    return commits.map((commit) => this.#place(commit));
  }

  #free(): number {
    const index = this.#lanes.indexOf(null);
    return index < 0 ? this.#lanes.length : index;
  }

  #place(commit: LayoutCommit): GraphRow {
    const lanes = this.#lanes;
    let names: Record<number, string> | undefined;
    const learn = (lane: Lane, name: string | undefined) => {
      if (lane.name || !name) return;
      lane.name = name;
      (names ??= {})[lane.color] = name;
    };
    let column = lanes.findIndex((lane) => lane?.sha === commit.sha);
    const isTip = column < 0;
    if (isTip) {
      column = this.#free();
      lanes[column] = { sha: commit.sha, color: this.#nextColor++ };
    }
    const own = lanes[column] as Lane;
    learn(own, branchOf(commit));
    const color = own.color;

    // Segments entrants : voies qui attendaient ce commit (elles le rejoignent), autres voies (elles passent).
    const up: Edge[] = [];
    lanes.forEach((lane, i) => {
      if (!lane || (isTip && i === column)) return;
      up.push({ from: i, to: lane.sha === commit.sha ? column : i, color: lane.color });
    });
    lanes.forEach((lane, i) => {
      if (lane?.sha === commit.sha && i !== column) lanes[i] = null;
    });

    // Parents : le premier prolonge la voie du commit, sauf s'il est déjà attendu ailleurs ; les autres ouvrent une voie.
    const down: Edge[] = [];
    /** Voies ouvertes par ce commit (pas de segment de passage au-dessus d'elles). */
    const created = new Set<number>();
    const [first, ...others] = commit.parents;
    if (first === undefined) lanes[column] = null;
    else {
      const existing = lanes.findIndex((lane, i) => i !== column && lane?.sha === first);
      if (existing >= 0) {
        lanes[column] = null;
        down.push({ from: column, to: existing, color: (lanes[existing] as Lane).color });
      } else {
        lanes[column] = { sha: first, color, name: own.name };
        down.push({ from: column, to: column, color });
      }
    }
    for (const parent of others) {
      let index = lanes.findIndex((lane) => lane?.sha === parent);
      if (index < 0) {
        index = this.#free();
        lanes[index] = { sha: parent, color: this.#nextColor++ };
        created.add(index);
      }
      learn(lanes[index] as Lane, mergedBranch(commit.summary));
      down.push({ from: column, to: index, color: (lanes[index] as Lane).color });
    }
    // Voies qui passent : ouvertes avant cette ligne et toujours ouvertes après (hors la colonne du commit et les
    // voies qu'il vient de créer), même si elles reçoivent aussi un parent du commit.
    for (const edge of up) {
      const lane = edge.from;
      if (edge.to === lane && lane !== column && lanes[lane] && !created.has(lane)) down.push({ from: lane, to: lane, color: edge.color });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(column, ...up.map((e) => Math.max(e.from, e.to)), ...down.map((e) => Math.max(e.from, e.to))) + 1;
    return names ? { column, color, up, down, width, names } : { column, color, up, down, width };
  }
}
