// Dépôts Git temporaires pour les tests : configuration de la machine ignorée, auteurs et dates fixés.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

// Isole les tests (et les commandes lancées par le code testé) de la configuration Git de la machine.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

export interface CommitOptions {
  author?: string;
  email?: string;
  /** Date ISO de l'auteur et du committer. */
  date?: string;
}

export interface TestRepo {
  root: string;
  git(...args: string[]): string;
  write(relPath: string, content: string): void;
  /** `git add -A` puis commit ; renvoie le SHA. */
  commit(message: string, options?: CommitOptions): string;
  dispose(): void;
}

function wrap(root: string): TestRepo {
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  run(['config', 'user.name', 'Test User']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
  return {
    root,
    git: (...args) => run(args),
    write(relPath, content) {
      const file = path.join(root, relPath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    commit(message, options = {}) {
      const date = options.date ?? '2026-01-01T12:00:00Z';
      run(['add', '-A']);
      run(['commit', '-q', '-m', message], {
        GIT_AUTHOR_NAME: options.author ?? 'Test User',
        GIT_AUTHOR_EMAIL: options.email ?? 'test@example.com',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      return run(['rev-parse', 'HEAD']).trim();
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function makeRepo(): TestRepo {
  const root = mkdtempSync(path.join(tmpdir(), 'git-forge-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return wrap(root);
}

export interface TestRemote {
  /** Chemin du dépôt nu, utilisable comme URL de remote. */
  url: string;
  /** Nouveau clone (remote « origin »). */
  clone(): TestRepo;
  dispose(): void;
}

export function makeRemote(): TestRemote {
  const url = mkdtempSync(path.join(tmpdir(), 'git-forge-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: url });
  const clones: TestRepo[] = [];
  return {
    url,
    clone() {
      const root = mkdtempSync(path.join(tmpdir(), 'git-forge-clone-'));
      execFileSync('git', ['clone', '-q', url, root], { stdio: 'ignore' });
      const repo = wrap(root);
      clones.push(repo);
      return repo;
    },
    dispose() {
      for (const repo of clones) repo.dispose();
      rmSync(url, { recursive: true, force: true });
    },
  };
}
