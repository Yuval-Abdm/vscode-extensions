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
  assert.deepStrictEqual(symbols.map((s) => s.name), ['Helper', 'BaseHelper', 'Renderer']);
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

test('SQL coloré dans la suite d’une requête concaténée', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('sql.php'));
  await vscode.window.showTextDocument(doc);
  const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', doc.uri);
  const words = await waitFor(async () => {
    const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', doc.uri);
    if (!tokens) return false;
    const out = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      line += tokens.data[i];
      character = tokens.data[i] === 0 ? character + tokens.data[i + 1] : tokens.data[i + 1];
      if (legend.tokenTypes[tokens.data[i + 3]] === 'keyword') out.push(`${line}:${doc.lineAt(line).text.slice(character, character + tokens.data[i + 2])}`);
    }
    return out.length ? out : false;
  }, 'tokens sémantiques');
  // « GROUP BY … ORDER BY » commence sur la ligne qui suit l'ouverture de la chaîne
  assert.deepStrictEqual(words, ['1:SELECT', '2:FROM', '3:WHERE', '4:GROUP', '4:BY', '4:ORDER', '4:BY']);
});

test('survol d’une ligne en erreur : correction appliquée d’un clic', async () => {
  const doc = await vscode.workspace.openTextDocument({ language: 'php', content: '<?php\n$a = 1\n$b = 2;\n' });
  await vscode.window.showTextDocument(doc);
  const link = await waitFor(async () => {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 1));
    for (const h of hovers ?? []) {
      for (const c of h.contents) {
        const m = /\]\(command:phpForge\.applyFix\?([^ )]+)\)/.exec(c.value ?? '');
        if (m) return { args: JSON.parse(decodeURIComponent(m[1])), trusted: c.isTrusted };
      }
    }
    return false;
  }, 'lien de correction dans le survol');
  // Le lien n'est cliquable que si la commande est autorisée dans le survol
  assert.deepStrictEqual(link.trusted, { enabledCommands: ['phpForge.applyFix'] });
  await vscode.commands.executeCommand('phpForge.applyFix', ...link.args);
  assert.strictEqual(doc.getText(), '<?php\n$a = 1;\n$b = 2;\n');
  // Second clic sur le même lien : le document a changé, rien n'est appliqué
  await vscode.commands.executeCommand('phpForge.applyFix', ...link.args);
  assert.strictEqual(doc.getText(), '<?php\n$a = 1;\n$b = 2;\n');
});

test('inclusions : variable non définie selon l’appelant, CodeLens', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('includes/footer.php'));
  await vscode.window.showTextDocument(doc);
  const diagnostic = await waitFor(
    () => vscode.languages.getDiagnostics(doc.uri).find((d) => d.code === 'undefined-variable'),
    'undefined-variable',
  );
  assert.match(diagnostic.message, /pages\/about\.php:2/);
  const lenses = await waitFor(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    return result && result.length ? result : false;
  }, 'codeLens');
  assert.strictEqual(lenses[0].command.title, 'Included by 2 files');
});

test('diagnostics : fichier non ouvert listé, correction « ignorer »', async () => {
  const legacy = ws('includes/legacy.php');
  const diagnostic = await waitFor(() => vscode.languages.getDiagnostics(legacy).find((d) => d.code === 'argument-count'), 'argument-count');
  const doc = await vscode.workspace.openTextDocument(legacy);
  await vscode.window.showTextDocument(doc);
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', legacy, diagnostic.range);
  assert.ok(actions.some((a) => a.title === 'Ignore argument-count on this line'), JSON.stringify(actions.map((a) => a.title)));
});

test('renommer une fonction dans tout le projet', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  await vscode.window.showTextDocument(doc);
  const line = doc.getText().split('\n').findIndex((l) => l.includes('format_price('));
  const position = new vscode.Position(line, doc.lineAt(line).text.indexOf('format_price') + 2);
  const edit = await waitFor(() => vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, position, 'formatPrice'), 'rename');
  const files = edit.entries().map(([uri]) => vscode.workspace.asRelativePath(uri)).sort();
  assert.deepStrictEqual(files, ['includes/functions.php', 'index.php']);
});

test('références et CodeLens d’implémentations', async () => {
  const uri = ws('includes/classes.php');
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const line = doc.getText().split('\n').findIndex((l) => l.startsWith('class Helper'));
  const refs = await waitFor(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, new vscode.Position(line, 7));
    return result && result.length ? result : false;
  }, 'references');
  assert.ok(refs.some((r) => r.uri.path.endsWith('/index.php')), JSON.stringify(refs.map((r) => r.uri.path)));
  const lenses = await waitFor(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 10);
    return result && result.some((l) => l.command && /implementation/.test(l.command.title)) ? result : false;
  }, 'codeLens implementations');
  assert.ok(lenses.some((l) => l.command.title === '1 implementation'), JSON.stringify(lenses.map((l) => l.command && l.command.title)));
});

test('mise en forme du document', async () => {
  const doc = await vscode.workspace.openTextDocument({ language: 'php', content: '<?php\nif($a){\nfoo( 1 );\n}\n' });
  await vscode.window.showTextDocument(doc);
  const edits = await waitFor(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: true });
    return result && result.length ? result : false;
  }, 'formatage');
  const edit = new vscode.WorkspaceEdit();
  edit.set(doc.uri, edits);
  await vscode.workspace.applyEdit(edit);
  assert.strictEqual(doc.getText(), '<?php\nif ($a) {\n    foo(1);\n}\n');
});

test('SQL : complétion des colonnes, survol, colonne inconnue', async () => {
  const doc = await vscode.workspace.openTextDocument({ language: 'php', content: '<?php\n$r = mysqli_query($db, "SELECT c.solde, c.prenom FROM clients c");\n' });
  await vscode.window.showTextDocument(doc);
  const at = new vscode.Position(1, doc.lineAt(1).text.indexOf('c.solde') + 2);
  const list = await waitFor(async () => {
    const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, at);
    return result && result.items.some((i) => (i.label.label ?? i.label) === 'solde') ? result : false;
  }, 'complétion SQL');
  assert.ok(list.items.some((i) => (i.label.label ?? i.label) === 'nom'));
  const hover = await waitFor(async () => {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, at.character + 2));
    const value = (hovers ?? []).flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n');
    return value.includes('decimal(10,2)') ? value : false;
  }, 'survol SQL');
  assert.match(hover, /NOT NULL/);
  const diagnostics = await waitFor(() => {
    const found = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'sql-unknown-column');
    return found.length ? found : false;
  }, 'colonne inconnue');
  assert.strictEqual(diagnostics[0].range.start.line, 1);
  assert.ok((await vscode.commands.getCommands(true)).includes('phpForge.refreshSqlSchema'));
});

test('sécurité : donnée de la requête affichée ; commande Migration report', async () => {
  const doc = await vscode.workspace.openTextDocument({ language: 'php', content: '<?php\n$q = $_GET["q"];\necho "<p>" . $q;\n' });
  await vscode.window.showTextDocument(doc);
  const found = await waitFor(() => {
    const list = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'security-xss');
    return list.length ? list : false;
  }, 'security-xss');
  assert.strictEqual(found[0].range.start.line, 2);
  assert.match(found[0].message, /\$_GET\["q"\] \(line 2\) → \$q → echo \(line 3\)/);
  assert.ok((await vscode.commands.getCommands(true)).includes('phpForge.migrationReport'));
});

test('vue Impact : fichier modifié non enregistré et ses pages', async () => {
  const doc = await vscode.workspace.openTextDocument(ws('includes/footer.php'));
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(doc.lineCount, 0), '\n// modification\n'));
  try {
    const entries = await waitFor(async () => {
      const list = await vscode.commands.executeCommand('phpForge.impactEntries');
      return list && list.some((e) => e.label === 'includes/footer.php') ? list : false;
    }, 'impact');
    const footer = entries.find((e) => e.label === 'includes/footer.php');
    assert.deepStrictEqual(footer.pages.map((p) => p.label), ['pages/about.php', 'pages/home.php']);
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
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
