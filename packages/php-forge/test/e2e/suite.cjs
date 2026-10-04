// Tests exécutés dans le VS Code lancé par run.cjs (extension host réel).
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const WS = process.env.PHP_FORGE_WORKSPACE;
const ws = (rel) => vscode.Uri.file(path.join(WS, rel));

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
    await new Promise((r) => setTimeout(r, 200));
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("s'active sur un projet PHP", async () => {
  const extension = vscode.extensions.getExtension('yuval-abdm.php-forge');
  assert.ok(extension);
  await extension.activate();
  assert.ok(extension.isActive);
});

test('plan du fichier', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('includes/classes.php'));
  await vscode.window.showTextDocument(doc);
  const symbols = await waitFor(async () => {
    const s = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    return s && s.length ? s : false;
  }, 'symboles');
  assert.deepStrictEqual(symbols.map((s) => s.name), ['Helper', 'BaseHelper']);
});

test('aller à la définition dans un fichier inclus', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  await vscode.window.showTextDocument(doc);
  const position = doc.positionAt(doc.getText().indexOf('format_price') + 2);
  const locations = await waitFor(async () => {
    const l = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, position);
    return l && l.length ? l : false;
  }, 'définition');
  const target = locations[0].uri ?? locations[0].targetUri;
  assert.ok(target.fsPath.endsWith(path.join('includes', 'functions.php')), target.fsPath);
});

test("survol d'une fonction native", async () => {
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  const position = doc.positionAt(doc.getText().indexOf('strlen') + 2);
  const text = await waitFor(async () => {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, position);
    const value = (hovers ?? []).flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n');
    return value.includes('strlen') ? value : false;
  }, 'survol');
  assert.match(text, /function strlen\(/);
});

test('erreurs de syntaxe', async () => {
  const doc = await vscode.workspace.openTextDocument({ language: 'php', content: '<?php\nfunction broken( {\n' });
  await vscode.window.showTextDocument(doc);
  const diagnostics = await waitFor(() => {
    const d = vscode.languages.getDiagnostics(doc.uri);
    return d.length ? d : false;
  }, 'diagnostics');
  assert.strictEqual(diagnostics[0].source, 'PHP Forge');
});

test('complétion des membres', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  await editor.edit((e) => e.insert(end, '\n$helper->'));
  const position = doc.lineAt(doc.lineCount - 1).range.end;
  const labels = await waitFor(async () => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
    const found = (list?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    return found.includes('render') ? found : false;
  }, 'complétion');
  assert.ok(labels.includes('render'));
});

test('aide aux paramètres', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  const position = doc.positionAt(doc.getText().indexOf('format_price(') + 'format_price('.length);
  const help = await waitFor(async () => {
    const h = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', doc.uri, position);
    return h && h.signatures.length ? h : false;
  }, 'aide aux paramètres');
  assert.match(help.signatures[0].label, /^format_price\(/);
});

test('indications inline', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  const hints = await waitFor(async () => {
    const h = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', doc.uri, range);
    const labels = (h ?? []).map((x) => (typeof x.label === 'string' ? x.label : x.label.map((p) => p.value).join('')));
    return labels.includes('amount:') ? labels : false;
  }, 'indications inline');
  assert.ok(hints.includes('amount:'));
});

async function run() {
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.log(`  ✗ ${name}\n    ${err && err.stack ? err.stack : err}`);
      failures.push(name);
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} tests e2e réussis`);
  if (failures.length) throw new Error(`${failures.length} test(s) e2e en échec`);
}

module.exports = { run };
