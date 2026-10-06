// Tests exécutés dans le VS Code lancé par run.cjs (extension host réel).
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const WS = process.env.GIT_FORGE_WORKSPACE;
const SHAS = JSON.parse(process.env.GIT_FORGE_SHAS);
const file = vscode.Uri.file(path.join(WS, 'a.txt'));
const gitIn = (...args) => execFileSync('git', args, { cwd: WS, encoding: 'utf8' });

async function waitFor(check, label, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await check();
      if (r !== false && r !== undefined) return r;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
    }
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let api;
const blame = () => api.feature('blame');

/** Attend que le texte de fin de ligne corresponde, puis vérifie qu'il ne change plus (pas de résultat périmé). */
async function blameText(pattern, label) {
  const matches = () => {
    const text = blame().line.currentText;
    return text !== undefined && (typeof pattern === 'string' ? text === pattern : pattern.test(text)) ? text : false;
  };
  await waitFor(matches, label);
  await new Promise((r) => setTimeout(r, 400));
  const text = blame().line.currentText;
  assert.ok(matches(), `texte après stabilisation : ${text}`);
  return text;
}

async function cursorAt(line) {
  const editor = await vscode.window.showTextDocument(file);
  editor.selection = new vscode.Selection(line, 0, line, 0);
  return editor;
}

test("s'active et crée la fonction blame", async () => {
  const extension = vscode.extensions.getExtension('yuval-abdm.git-forge');
  assert.ok(extension);
  api = await extension.activate();
  await waitFor(() => blame(), 'fonction blame');
});

test('blame de la ligne courante', async () => {
  await cursorAt(1);
  await blameText(/^Bob, .* • second commit$/, 'blame ligne 2');
});

test('curseur déplacé vite : le texte suit la dernière ligne', async () => {
  const editor = await cursorAt(1);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  editor.selection = new vscode.Selection(2, 0, 2, 0);
  await blameText(/^Alice, .* • first commit$/, 'blame ligne 3');
});

test('ligne ajoutée non enregistrée : non commitée', async () => {
  const editor = await cursorAt(0);
  await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'new line\n'));
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await blameText('You • Uncommitted changes', 'blame ligne ajoutée');
  await vscode.commands.executeCommand('workbench.action.files.revert');
});

test('blame du fichier entier : bascule', async () => {
  await vscode.window.showTextDocument(file);
  await vscode.commands.executeCommand('gitForge.toggleFileBlame');
  assert.equal(blame().file.isEnabled(file), true);
  await vscode.commands.executeCommand('gitForge.toggleFileBlame');
  assert.equal(blame().file.isEnabled(file), false);
});

test('comparer avec la révision précédente', async () => {
  await vscode.commands.executeCommand('gitForge.diffWithPrevious', { root: WS, sha: SHAS.second, path: 'a.txt', previousSha: SHAS.first, previousPath: 'a.txt' });
  const input = await waitFor(() => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input instanceof vscode.TabInputTextDiff ? tab.input : false;
  }, 'éditeur de diff');
  assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'one\ntwo\nthree\n');
  assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'one\nTWO\nthree\n');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
});

test('historique du fichier', async () => {
  await vscode.commands.executeCommand('gitForge.showFileHistory', file);
  const view = await waitFor(() => api.feature('history'), 'vue historique');
  await waitFor(() => view.entries.length === 2 || undefined, 'deux commits');
  assert.deepEqual(view.entries.map((e) => e.summary), ['second commit', 'first commit']);
  assert.deepEqual(view.entries[0].files, [{ status: 'M', path: 'a.txt' }]);
});

test("historique d'une ligne", async () => {
  await cursorAt(0);
  await vscode.commands.executeCommand('gitForge.showLineHistory');
  const view = api.feature('history');
  await waitFor(() => (view.target && view.target.kind === 'lines' && view.entries.length === 1 && view.entries[0].summary === 'first commit') || undefined, 'ligne 1 : un commit');
  assert.deepEqual([view.target.start, view.target.end], [1, 1]);
});

test("ouvrir un diff depuis l'historique ne change pas le fichier suivi", async () => {
  const view = api.feature('history');
  const target = view.target;
  await vscode.commands.executeCommand('gitForge.diffWithPrevious', { root: WS, sha: SHAS.second, path: 'a.txt', previousSha: SHAS.first, previousPath: 'a.txt' });
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(view.target, target);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
});

test('merge local en conflit, résolu dans la vue Conflicts, branche supprimée à la fin', async () => {
  gitIn('switch', '-q', '-c', 'feature');
  require('fs').writeFileSync(path.join(WS, 'a.txt'), 'one\nTWO\nfeature\n');
  gitIn('commit', '-q', '-am', 'feature change');
  gitIn('switch', '-q', 'main');
  require('fs').writeFileSync(path.join(WS, 'a.txt'), 'one\nTWO\nmain\n');
  gitIn('commit', '-q', '-am', 'main change');

  const merge = await waitFor(() => api.feature('merge'), 'commande merge');
  const outcome = await merge.execute(WS, { source: 'feature', noFf: false, deleteSource: 'local' });
  assert.equal(outcome.kind, 'conflicts');

  const view = api.feature('conflicts');
  await view.refresh();
  await waitFor(() => view.files.length === 1 || undefined, 'un fichier en conflit');
  const fileNode = view.files[0];
  assert.equal(fileNode.conflict.path, 'a.txt');
  assert.equal(fileNode.blocks.length, 1);

  // Marquer résolu avec les marqueurs encore présents : refusé.
  await vscode.commands.executeCommand('gitForge.conflicts.markResolved', fileNode);
  assert.equal(view.files.length, 1);

  const [block] = view.getChildren(fileNode);
  await vscode.commands.executeCommand('gitForge.conflicts.keepTheirs', block);
  assert.equal(require('fs').readFileSync(path.join(WS, 'a.txt'), 'utf8'), 'one\nTWO\nfeature\n');

  await vscode.commands.executeCommand('gitForge.conflicts.markResolved', view.files[0]);
  await waitFor(() => view.files.length === 0 || undefined, 'plus de conflit');
  await vscode.commands.executeCommand('gitForge.conflicts.finish');
  assert.equal(gitIn('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
  assert.equal(gitIn('branch', '--list', 'feature').trim(), '');
  assert.equal(gitIn('status', '--porcelain').trim(), '');
});

test('comparer deux commits, puis avec l’arbre de travail', async () => {
  const feature = await waitFor(() => api.feature('compare'), 'fonction compare');
  await feature.compare.compare({ root: WS, left: SHAS.first, right: SHAS.second, mode: 'direct' });
  assert.deepEqual(feature.compare.result.changes, [{ status: 'M', path: 'a.txt' }]);
  assert.deepEqual(feature.compare.result.commits.map((e) => e.summary), ['second commit']);
  require('fs').writeFileSync(path.join(WS, 'b.txt'), 'new\n');
  gitIn('add', 'b.txt');
  await feature.compare.compare({ root: WS, left: 'HEAD', mode: 'direct' });
  assert.deepEqual(feature.compare.result.changes, [{ status: 'A', path: 'b.txt' }]);
  gitIn('rm', '-q', '--cached', 'b.txt');
  require('fs').unlinkSync(path.join(WS, 'b.txt'));
});

test('stash : créer, lister, pop', async () => {
  const { stashes } = api.feature('compare');
  require('fs').writeFileSync(path.join(WS, 'a.txt'), 'stash me\n');
  await stashes.push(WS, 'e2e stash');
  assert.equal(gitIn('status', '--porcelain').trim(), '');
  await waitFor(() => stashes.stashes.length === 1 || undefined, 'un stash');
  assert.match(stashes.stashes[0].message, /e2e stash/);
  await stashes.apply({ type: 'stash', root: WS, stash: stashes.stashes[0] }, true);
  assert.equal(require('fs').readFileSync(path.join(WS, 'a.txt'), 'utf8'), 'stash me\n');
  await waitFor(() => stashes.stashes.length === 0 || undefined, 'stash consommé');
  gitIn('checkout', '--', 'a.txt');
});

test('worktrees : le dépôt principal est listé', async () => {
  const { worktrees } = api.feature('compare');
  await worktrees.refresh();
  assert.equal(worktrees.worktrees.length, 1);
  assert.equal(worktrees.worktrees[0].branch, 'main');
});

test('graphe : tous les commits chargés, copier un SHA depuis le menu', async () => {
  await vscode.commands.executeCommand('gitForge.showGraph');
  const graph = await waitFor(() => api.feature('graph'), 'fonction graph');
  const total = Number(gitIn('rev-list', '--all', '--exclude=refs/stash', '--count').trim());
  await waitFor(() => (graph.panel && graph.panel.rows.length === total) || undefined, 'lignes du graphe');
  const head = gitIn('rev-parse', 'HEAD').trim();
  assert.equal(graph.panel.rows[0].sha, head);
  assert.ok(graph.panel.rows[0].refs.some((ref) => ref.kind === 'branch' && ref.current));
  await vscode.commands.executeCommand('gitForge.graph.copySha', { sha: head });
  assert.equal(await vscode.env.clipboard.readText(), head);
  graph.panel.dispose();
});

test('graphe dans la barre latérale (conteneur Git Forge) : commits chargés, menu sur la vue', async () => {
  await vscode.commands.executeCommand('gitForge.graphView.focus');
  const graph = api.feature('graph');
  const total = Number(gitIn('rev-list', '--branches', '--remotes', '--tags', 'HEAD', '--count').trim());
  await waitFor(() => (graph.sidebar.session && graph.sidebar.session.rows.length === total) || undefined, 'lignes de la vue latérale');
  assert.equal(graph.sidebar.session.root, WS);
  const sha = graph.sidebar.session.rows[1].sha;
  await vscode.commands.executeCommand('gitForge.graph.copySha', { webview: 'gitForge.graphView', root: WS, sha });
  assert.equal(await vscode.env.clipboard.readText(), sha);
});

test('cherry-pick puis revert sans confirmation, reset soft avec sauvegarde', async () => {
  const ops = await waitFor(() => api.feature('operations'), 'fonction operations');
  gitIn('switch', '-q', '-c', 'pick-source');
  require('fs').writeFileSync(path.join(WS, 'picked.txt'), 'picked\n');
  gitIn('add', 'picked.txt');
  gitIn('commit', '-q', '-m', 'to pick');
  const picked = gitIn('rev-parse', 'HEAD').trim();
  gitIn('switch', '-q', 'main');
  await ops.cherryPick(WS, picked, false);
  assert.equal(gitIn('log', '-1', '--format=%s').trim(), 'to pick');
  await ops.revert(WS, gitIn('rev-parse', 'HEAD').trim(), false);
  assert.match(gitIn('log', '-1', '--format=%s').trim(), /^Revert "to pick"/);
  const before = gitIn('rev-parse', 'HEAD').trim();
  await ops.reset(WS, gitIn('rev-parse', 'HEAD~2').trim(), 'soft', false);
  assert.equal(gitIn('rev-parse', 'HEAD').trim(), gitIn('rev-parse', `${before}~2`).trim());
  assert.ok(gitIn('tag', '--list', 'git-forge/backup/*').trim());
  gitIn('reset', '-q', '--hard', before);
  gitIn('branch', '-q', '-D', 'pick-source');
});

test('cherry-pick d’un commit déjà dans HEAD : refusé, aucune opération en cours', async () => {
  const ops = api.feature('operations');
  const before = gitIn('rev-parse', 'HEAD').trim();
  await ops.cherryPick(WS, gitIn('rev-parse', 'HEAD~1').trim(), false);
  assert.equal(gitIn('rev-parse', 'HEAD').trim(), before);
  assert.equal(gitIn('status', '--porcelain').trim(), '');
});

test('chaque fonction : désactivée puis réactivée, ses commandes fonctionnent encore', async () => {
  const config = vscode.workspace.getConfiguration('gitForge');
  for (const key of ['history', 'conflicts', 'merge', 'compare', 'graph', 'operations']) {
    await config.update(`${key}.enabled`, false, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.feature(key) === undefined || undefined, `${key} désactivée`);
    await config.update(`${key}.enabled`, undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.feature(key), `${key} réactivée`);
  }
  await vscode.commands.executeCommand('gitForge.showFileHistory', file);
  await waitFor(() => api.feature('history').entries.length > 0 || undefined, 'historique après réactivation');
  await vscode.commands.executeCommand('gitForge.conflicts.refresh');
  await vscode.commands.executeCommand('gitForge.showGraph');
  await waitFor(() => (api.feature('graph').panel && api.feature('graph').panel.rows.length > 0) || undefined, 'graphe après réactivation');
  api.feature('graph').panel.dispose();
});

test('vue Commit : indexer un fichier, commiter avec un message conventionnel', async () => {
  const view = await waitFor(() => api.feature('commit'), 'fonction commit');
  await vscode.commands.executeCommand('gitForge.commitView.focus');
  await vscode.window.showTextDocument(file);
  await view.refresh();
  assert.equal(view.root, WS);
  require('fs').writeFileSync(path.join(WS, 'from-commit-view.txt'), 'x\n');
  await view.stage(['from-commit-view.txt']);
  assert.ok(gitIn('diff', '--cached', '--name-only').includes('from-commit-view.txt'));
  assert.equal(await view.commit('fix(e2e): commit depuis la vue', false), true);
  assert.equal(gitIn('log', '-1', '--format=%s').trim(), 'fix(e2e): commit depuis la vue');
  assert.equal(gitIn('status', '--porcelain').trim(), '');
});

test('désactivée par réglage, puis réactivée', async () => {
  const config = vscode.workspace.getConfiguration('gitForge');
  await config.update('blame.enabled', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => blame() === undefined || undefined, 'blame désactivé');
  await config.update('blame.enabled', undefined, vscode.ConfigurationTarget.Global);
  await waitFor(() => blame(), 'blame réactivé');
});

async function run() {
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.log(`  ✗ ${name}\n    ${err && err.stack}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} test(s) e2e en échec : ${failures.join(', ')}`);
}

module.exports = { run };
