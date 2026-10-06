// Placement du graphe des commits (sans dépendance à VS Code). Les commits arrivent enfants avant parents ; chaque
// colonne (« voie ») attend un commit précis. Pour chaque ligne : colonne du commit, segments entrants (du haut de la
// ligne vers le milieu) et sortants (du milieu vers le bas), avec la couleur de leur voie.

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
}

interface Lane {
  sha: string;
  color: number;
}

export class GraphLayout {
  /** Voies ouvertes : commit attendu par colonne (null : colonne libre). */
  #lanes: (Lane | null)[] = [];
  #nextColor = 0;

  add(commits: readonly { sha: string; parents: readonly string[] }[]): GraphRow[] {
    return commits.map((commit) => this.#place(commit));
  }

  #free(): number {
    const index = this.#lanes.indexOf(null);
    return index < 0 ? this.#lanes.length : index;
  }

  #place(commit: { sha: string; parents: readonly string[] }): GraphRow {
    const lanes = this.#lanes;
    let column = lanes.findIndex((lane) => lane?.sha === commit.sha);
    const isTip = column < 0;
    if (isTip) {
      column = this.#free();
      lanes[column] = { sha: commit.sha, color: this.#nextColor++ };
    }
    const color = (lanes[column] as Lane).color;

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
        lanes[column] = { sha: first, color };
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
    return { column, color, up, down, width };
  }
}
