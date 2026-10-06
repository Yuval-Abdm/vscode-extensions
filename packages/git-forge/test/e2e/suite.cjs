// Tests exécutés dans le VS Code lancé par run.cjs (extension host réel).
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const WS = process.env.GIT_FORGE_WORKSPACE;
const SHAS = JSON.parse(process.env.GIT_FORGE_SHAS);
const file = vscode.Uri.file(path.join(WS, 'a.txt'));

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
