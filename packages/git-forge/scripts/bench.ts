// Mesure des objectifs de performance (spec §7) sur un dépôt de 10 000 commits construit avec git fast-import :
// blame de la ligne courante (cache chaud) < 100 ms, première page du graphe (500 commits placés) < 500 ms.
// Lancement : npm run bench (sort en erreur si un objectif n'est pas tenu).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { BlameService } from '../src/features/blame/service.ts';
import { GraphLayout } from '../src/features/graph/layout.ts';
import { GitCommands } from '../src/git/commands.ts';
import { GitRunner } from '../src/git/runner.ts';

const COMMITS = 10_000;
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

/** Dépôt synthétique : une branche principale, une branche mergée tous les 50 commits, 200 fichiers. */
function buildRepo(root: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const lines: string[] = [];
  let mark = 0;
  let mainMark = 0;
  const time = 1_700_000_000;
  const blob = (content: string) => {
    lines.push('blob', `mark :${++mark}`, `data ${Buffer.byteLength(content)}`, content);
    return mark;
  };
  for (let i = 1; i <= COMMITS; i++) {
    const file = `src/file${i % 200}.txt`;
    const content = Array.from({ length: 50 }, (_, line) => `line ${line} of ${file} at ${line === i % 50 ? i : 0}`).join('\n') + '\n';
    const data = blob(content);
    const message = `commit ${i}`;
    const side = i % 50 === 0;
    lines.push(`commit refs/heads/${side ? 'side' : 'main'}`, `mark :${++mark}`, `author Bench <b@example.com> ${time + i} +0000`, `committer Bench <b@example.com> ${time + i} +0000`, `data ${message.length}`, message);
    if (mainMark) lines.push(`from :${mainMark}`);
    lines.push(`M 100644 :${data} ${file}`);
    if (side) {
      // Branche « side » mergée aussitôt dans main.
      const sideMark = mark;
      const merge = `merge ${i}`;
      lines.push(`commit refs/heads/main`, `mark :${++mark}`, `author Bench <b@example.com> ${time + i} +0000`, `committer Bench <b@example.com> ${time + i} +0000`, `data ${merge.length}`, merge, `from :${mainMark}`, `merge :${sideMark}`);
      mainMark = mark;
    } else {
      mainMark = mark;
    }
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: lines.join('\n') + '\n', maxBuffer: 1 << 30 });
  execFileSync('git', ['checkout', '-q', '-f', 'main'], { cwd: root });
}

async function median(label: string, run: () => Promise<unknown>, times = 5): Promise<number> {
  const durations: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    await run();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const value = durations[Math.floor(times / 2)];
  console.log(`${label.padEnd(44)} ${value.toFixed(1).padStart(8)} ms`);
  return value;
}

const root = mkdtempSync(path.join(tmpdir(), 'git-forge-bench-'));
try {
  console.log(`Construction d'un dépôt de ${COMMITS} commits…`);
  buildRepo(root);
  const git = new GitCommands(new GitRunner('git'));
  const head = await git.revParse(root, 'HEAD');
  const service = new BlameService(git, { locate: () => ({ root, head }) }, () => 20_000);
  const fileName = path.join(root, 'src/file7.txt');
  const text = execFileSync('git', ['show', 'HEAD:src/file7.txt'], { cwd: root, encoding: 'utf8' });
  const doc = { fileName, version: 1, isDirty: false, lineCount: text.split('\n').length, getText: () => text };

  const cold = await median('blame du fichier (cache froid, 1 essai)', () => service.fileBlame(doc), 1);
  const warm = await median('blame de la ligne courante (cache chaud)', () => service.lineInfo(doc, 10));
  const graph = await median('graphe : première page (500 commits placés)', async () => new GraphLayout().add(await git.graph(root, { all: true, limit: 500 })));
  const history = await median("historique d'un fichier (50 commits)", () => git.fileHistory(root, 'src/file7.txt'));
  void cold;
  void history;

  const failures = [warm >= 100 && 'blame cache chaud ≥ 100 ms', graph >= 500 && 'graphe ≥ 500 ms'].filter(Boolean);
  if (failures.length) {
    console.error(`Objectifs non tenus : ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Objectifs tenus.');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
