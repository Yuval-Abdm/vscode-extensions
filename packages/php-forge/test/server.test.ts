// Serveur complet lancé comme par VS Code (stdio) sur le projet de test : indexation, cache, requêtes, robustesse.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { URI } from 'vscode-uri';
import type { IndexedParams, StatusParams } from '../src/shared/protocol.ts';

const pkg = path.join(import.meta.dirname, '..');
const fixture = path.join(pkg, 'test/fixtures/basic-project');
const uri = (rel: string) => URI.file(path.join(fixture, rel)).toString();
const hasStubs = existsSync(path.join(pkg, 'dist/stubs.json.gz'));

interface Server {
  child: ChildProcess;
  connection: MessageConnection;
  indexed: IndexedParams;
  diagnostics: Map<string, { code: string; range: { start: { line: number } } }[]>;
  statuses: StatusParams[];
  /** Toutes les publications, avec la version du document */
  baseline: { hidden: number }[];
  history: { uri: string; version?: number; diagnostics: { code: string; range: { start: { line: number } } }[] }[];
}

async function startServer(storagePath: string): Promise<Server> {
  const child = spawn(process.execPath, [path.join(pkg, 'dist/server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
  const diagnostics: Server['diagnostics'] = new Map();
  const history: Server['history'] = [];
  const baseline: Server['baseline'] = [];
  connection.onNotification('phpForge/baselineStatus', (params) => {
    baseline.push(params as { hidden: number });
  });
  const indexed = new Promise<IndexedParams>((resolve) => connection.onNotification('phpForge/indexed', resolve));
  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    const p = params as { uri: string; diagnostics: Server['diagnostics'] extends Map<string, infer D> ? D : never };
    diagnostics.set(p.uri, p.diagnostics);
    history.push(params as Server['history'][number]);
  });
  const statuses: StatusParams[] = [];
  connection.onNotification('phpForge/status', (params) => {
    statuses.push(params as StatusParams);
  });
  connection.onRequest(() => null);
  connection.listen();
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: URI.file(fixture).toString(),
    workspaceFolders: [{ uri: URI.file(fixture).toString(), name: 'basic-project' }],
    capabilities: {},
    initializationOptions: { storagePath },
  });
  await connection.sendNotification('initialized', {});
  return { child, connection, indexed: await indexed, diagnostics, statuses, history, baseline };
}

async function stopServer(server: Server): Promise<void> {
  await server.connection.sendRequest('shutdown');
  await server.connection.sendNotification('exit');
  server.connection.dispose();
}

async function open(server: Server, rel: string, text: string): Promise<void> {
  await server.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: uri(rel), languageId: 'php', version: 1, text } });
}

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${label}`);
}

describe('serveur LSP', () => {
  const storage = mkdtempSync(path.join(tmpdir(), 'php-forge-storage-'));
  let server: Server;

  before(async () => {
    server = await startServer(storage);
  });
  after(async () => {
    await stopServer(server);
    rmSync(path.join(fixture, '.vscode'), { recursive: true, force: true });
  });

  it('indexe le projet et écrit le cache', () => {
    assert.deepEqual({ ...server.indexed.stats, ms: 0 }, { files: 9, parsed: 9, fromCache: 0, skipped: 0, syntaxErrors: 1, ms: 0 });
    assert.equal(readdirSync(storage).filter((f) => f.endsWith('.json.gz')).length, 1);
  });

  it('aller à la définition vers un fichier inclus', async () => {
    const text = (await import('node:fs')).readFileSync(path.join(fixture, 'index.php'), 'utf8');
    await open(server, 'index.php', text);
    const line = text.split('\n').findIndex((l) => l.includes('format_price'));
    const locations = (await server.connection.sendRequest('textDocument/definition', {
      textDocument: { uri: uri('index.php') }, position: { line, character: 7 },
    })) as { uri: string }[];
    assert.deepEqual(locations.map((l) => l.uri), [uri('includes/functions.php')]);
  });

  it('survol d’une fonction native', { skip: !hasStubs }, async () => {
    const line = 6; // echo strlen('abc');
    const result = (await server.connection.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('index.php') }, position: { line, character: 7 },
    })) as { contents: { value: string } };
    assert.match(result.contents.value, /strlen\(/);
  });

  it('plan d’un fichier non ouvert (depuis l’index)', async () => {
    const symbols = (await server.connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri: uri('includes/classes.php') } })) as { name: string }[];
    assert.deepEqual(symbols.map((s) => s.name), ['Helper', 'BaseHelper', 'Renderer']);
  });

  it('recherche de symboles dans le workspace', async () => {
    const symbols = (await server.connection.sendRequest('workspace/symbol', { query: 'helper' })) as { name: string }[];
    assert.equal(symbols[0].name, 'Helper');
  });

  it('erreurs de syntaxe publiées à l’ouverture', async () => {
    await open(server, 'broken.php', '<?php\nfunction broken( {\n');
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('broken.php')), 'diagnostics');
    assert.equal(diagnostics[0].code, 'syntax-error');
  });

  it('variable non définie selon l’appelant (moteur d’inclusion)', async () => {
    const footer = path.join(fixture, 'includes/footer.php');
    await open(server, 'includes/footer.php', readFileSync(footer, 'utf8'));
    const found = await waitFor(() => server.diagnostics.get(uri('includes/footer.php'))?.find((d) => d.code === 'undefined-variable'), 'undefined-variable');
    assert.equal((found as unknown as { message: string }).message, '$footer_text is not defined when included from pages/about.php:2 (defined in 1 other caller)');
  });

  it('frappe : les alertes d’inclusion suivent le texte jusqu’à la prochaine analyse', async () => {
    const footer = uri('includes/footer.php');
    await waitFor(() => server.diagnostics.get(footer)?.find((d) => d.code === 'undefined-variable'), 'undefined-variable');
    await server.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri: footer, version: 2 },
      contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: '// note\n' }],
    });
    // Première publication après la frappe (avant la nouvelle analyse) : déjà au bon endroit
    const first = await waitFor(() => server.history.find((h) => h.uri === footer && h.version === 2), 'publication');
    assert.deepEqual(first.diagnostics.filter((d) => d.code === 'undefined-variable').map((d) => d.range.start.line), [2]);
    await server.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri: footer, version: 3 },
      contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, text: '' }],
    });
    await waitFor(() => server.diagnostics.get(footer)?.find((d) => d.code === 'undefined-variable' && d.range.start.line === 1), 'revenue');
  });

  it('CodeLens « Included by » et appelants', async () => {
    const lenses = await waitFor(async () => {
      const result = (await server.connection.sendRequest('textDocument/codeLens', { textDocument: { uri: uri('includes/footer.php') } })) as { command: { title: string } }[];
      return result.length ? result : undefined;
    }, 'codeLens');
    assert.equal(lenses[0].command.title, 'Included by 2 files');
    const includers = (await server.connection.sendRequest('phpForge/includers', { uri: uri('includes/footer.php') })) as { label: string }[];
    assert.deepEqual(includers.map((i) => i.label).sort(), ['pages/about.php:2', 'pages/home.php:3']);
  });

  it('fichier non ouvert : diagnostics publiés par la passe du workspace', async () => {
    const found = await waitFor(() => server.diagnostics.get(uri('includes/legacy.php'))?.find((d) => d.code === 'argument-count'), 'argument-count');
    assert.equal(found.range.start.line, 6);
  });

  it('niveau par règle et baseline', async () => {
    await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: { phpForge: { diagnostics: { rules: { 'argument-count': 'off' }, scope: 'workspace' } } } });
    await waitFor(() => (server.diagnostics.get(uri('includes/legacy.php'))?.some((d) => d.code === 'argument-count') ? undefined : true), 'règle désactivée');
    await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: { phpForge: {} } });
    await waitFor(() => server.diagnostics.get(uri('includes/legacy.php'))?.find((d) => d.code === 'argument-count'), 'règle réactivée');
    const result = (await server.connection.sendRequest('phpForge/baseline', { action: 'create' })) as { entries: number };
    assert.ok(result.entries > 0);
    await waitFor(() => (server.diagnostics.get(uri('includes/legacy.php'))?.length ? undefined : true), 'masqué par la baseline');
    await waitFor(() => (server.baseline.at(-1)?.hidden ? true : undefined), 'alertes masquées dans la barre d’état');
    await server.connection.sendRequest('phpForge/baseline', { action: 'clear' });
    await waitFor(() => server.diagnostics.get(uri('includes/legacy.php'))?.find((d) => d.code === 'argument-count'), 'baseline supprimée');
  });

  it('diagnostics sémantiques décalés pendant la frappe', async () => {
    await open(server, 'shift.php', '<?php\nnope_shift();\n');
    await waitFor(() => server.diagnostics.get(uri('shift.php'))?.find((d) => d.code === 'undefined-function'), 'undefined-function');
    await server.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri: uri('shift.php'), version: 2 },
      contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: '\n' }],
    });
    const first = await waitFor(() => server.history.find((h) => h.uri === uri('shift.php') && h.version === 2), 'publication v2');
    assert.deepEqual(first.diagnostics.filter((d) => d.code === 'undefined-function').map((d) => d.range.start.line), [2]);
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('shift.php') } });
  });

  it('« ; » manquant signalé, avec sa correction rapide', async () => {
    await open(server, 'semicolon.php', '<?php\n$a = 1\n$b = 2;\n');
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('semicolon.php')), 'diagnostics');
    assert.equal(diagnostics[0].code, 'missing-semicolon');
    const actions = (await server.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('semicolon.php') }, range: diagnostics[0].range, context: { diagnostics },
    })) as { edit: { changes: Record<string, { newText: string }[]> } }[];
    assert.equal(actions[0].edit.changes[uri('semicolon.php')][0].newText, ';');
  });

  it('survol d’une ligne en erreur : problème et lien de correction', async () => {
    await open(server, 'semicolon-hover.php', '<?php\n$a = 1\n$b = 2;\n');
    await waitFor(() => server.diagnostics.get(uri('semicolon-hover.php')), 'diagnostics');
    const result = (await server.connection.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('semicolon-hover.php') }, position: { line: 1, character: 1 },
    })) as { contents: { value: string } };
    assert.match(result.contents.value, /command:phpForge\.applyFix\?/);
  });

  it('requête SQL aux guillemets mélangés', async () => {
    await open(server, 'quotes.php', `<?php\n$sql = 'UPDATE t SET a'.$d." = '". $h ."' WHERE id = 1";\n`);
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('quotes.php')), 'diagnostics');
    assert.deepEqual(diagnostics.map((d) => d.code), ['sql-mixed-quotes']);
  });

  it('valeur non affichée dans du HTML, avec ses corrections rapides', async () => {
    await open(server, 'tags.php', '<div><?$nom?></div>\n');
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('tags.php')), 'diagnostics');
    assert.equal(diagnostics[0].code, 'useless-output');
    const actions = (await server.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('tags.php') }, range: diagnostics[0].range, context: { diagnostics },
    })) as { edit: { changes: Record<string, { newText: string }[]> } }[];
    // Corrections du diagnostic, puis « ignorer » : la ligne est dans du HTML, le commentaire est entouré de balises PHP
    assert.deepEqual(actions.map((a) => a.edit.changes[uri('tags.php')][0].newText), ['<?=', '<?php echo ', '<?php // @php-forge-ignore useless-output ?>\n', '<?php /** @php-forge-ignore-file useless-output */ ?>\n']);
  });

  it('document non ouvert ou inconnu : réponse vide, le serveur continue', async () => {
    const result = await server.connection.sendRequest('textDocument/definition', { textDocument: { uri: 'file:///inconnu.php' }, position: { line: 0, character: 0 } });
    assert.deepEqual(result, []);
    const hover = await server.connection.sendRequest('textDocument/hover', { textDocument: { uri: 'file:///inconnu.php' }, position: { line: 0, character: 0 } });
    assert.equal(hover, null);
    const symbols = (await server.connection.sendRequest('workspace/symbol', { query: 'format' })) as unknown[];
    assert.ok(symbols.length > 0);
  });

  it('dossier supprimé puis recréé (événements du système de fichiers)', async () => {
    const names = async () => ((await server.connection.sendRequest('workspace/symbol', { query: 'helper' })) as { name: string }[]).map((s) => s.name);
    await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('includes'), type: 3 }] });
    assert.deepEqual(await waitFor(async () => ((await names()).includes('Helper') ? undefined : await names()), 'suppression'), []);
    await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('includes'), type: 1 }] });
    assert.ok(await waitFor(async () => ((await names()).includes('Helper') ? true : undefined), 'création'));
  });

  it('version de PHP envoyée au client', async () => {
    const status = await waitFor(() => server.statuses[0], 'status');
    assert.ok(['composer', 'php', 'default'].includes(status.source));
  });

  it('complétion des membres typés', async () => {
    await open(server, 'complete.php', "<?php\nrequire 'includes/classes.php';\n$h = new Helper();\n$h->");
    const result = (await server.connection.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('complete.php') }, position: { line: 3, character: 4 },
    })) as { items: { label: string }[] };
    const labels = result.items.map((i) => i.label);
    assert.ok(labels.includes('render'));
    assert.ok(!labels.includes('escape'));
  });

  it('aide aux paramètres', async () => {
    await open(server, 'signature.php', '<?php format_price(');
    const result = (await server.connection.sendRequest('textDocument/signatureHelp', {
      textDocument: { uri: uri('signature.php') }, position: { line: 0, character: 19 },
    })) as { signatures: { label: string }[] };
    assert.match(result.signatures[0].label, /^format_price\(float \$amount\)/);
  });

  it('indications inline et tokens sémantiques', async () => {
    const hints = (await server.connection.sendRequest('textDocument/inlayHint', {
      textDocument: { uri: uri('index.php') }, range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
    })) as { label: string }[];
    assert.ok(hints.some((h) => h.label === 'amount:'));
    const tokens = (await server.connection.sendRequest('textDocument/semanticTokens/full', { textDocument: { uri: uri('index.php') } })) as { data: number[] };
    assert.ok(tokens.data.length > 0 && tokens.data.length % 5 === 0);
  });

  it('changement de réglage : nouvelle version de PHP', async () => {
    await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: { phpForge: { phpVersion: '5.6' } } });
    assert.ok(await waitFor(() => server.statuses.find((s) => s.phpVersion === '5.6'), 'statut 5.6'));
  });

  it('baseline demandée juste après le démarrage : alertes des inclusions comprises', async () => {
    const third = await startServer(mkdtempSync(path.join(tmpdir(), 'php-forge-storage-')));
    try {
      // Une frappe repousse l'analyse des inclusions : la baseline doit l'attendre
      await open(third, 'pending.php', '<?php\n');
      await third.connection.sendNotification('textDocument/didChange', { textDocument: { uri: uri('pending.php'), version: 2 }, contentChanges: [{ text: '<?php\n$a = 1;\n' }] });
      await third.connection.sendRequest('phpForge/baseline', { action: 'create' });
      const saved = readFileSync(path.join(fixture, '.vscode/php-forge-baseline.json'), 'utf8');
      assert.match(saved, /undefined-variable/);
    } finally {
      await third.connection.sendRequest('phpForge/baseline', { action: 'clear' });
      await stopServer(third);
    }
  });

  it('formatage du document et à la frappe', async () => {
    await open(server, 'fmt.php', '<?php\nif($a){\nfoo( 1 );\n}\n');
    const options = { tabSize: 4, insertSpaces: true };
    const edits = (await server.connection.sendRequest('textDocument/formatting', { textDocument: { uri: uri('fmt.php') }, options })) as { newText: string }[];
    assert.ok(edits.some((e) => e.newText === '\n    '), JSON.stringify(edits));
    const typed = (await server.connection.sendRequest('textDocument/onTypeFormatting', { textDocument: { uri: uri('fmt.php') }, position: { line: 2, character: 9 }, ch: ';', options })) as { range: { start: { line: number } } }[];
    assert.ok(typed.length > 0 && typed.every((e) => e.range.start.line === 2 || e.range.start.line === 1), JSON.stringify(typed));
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('fmt.php') } });
  });

  it('SQL : colonne inconnue selon sql/schema.sql, puis schéma de la base (cache observé)', async () => {
    await open(server, 'clients.php', '<?php\n$r = mysqli_query($db, "SELECT nom, prenom FROM clients");\n$s = mysqli_query($db, "SELECT * FROM inconnue");\n');
    const sqlCodes = () => server.diagnostics.get(uri('clients.php'))?.filter((d) => d.code.startsWith('sql-')).map((d) => `${d.range.start.line}:${d.code}`);
    assert.deepEqual(await waitFor(() => (sqlCodes()?.length ? sqlCodes() : undefined), 'colonne inconnue'), ['1:sql-unknown-column']);
    mkdirSync(path.join(fixture, '.vscode'), { recursive: true });
    const cache = { database: 'crm', refreshed: '', tables: [{ name: 'clients', columns: ['id', 'nom', 'solde', 'prenom'].map((name) => ({ name, type: 'int', nullable: true })) }] };
    writeFileSync(path.join(fixture, '.vscode/php-forge-schema.json'), JSON.stringify(cache));
    await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('.vscode/php-forge-schema.json'), type: 1 }] });
    assert.deepEqual(await waitFor(() => (sqlCodes()?.join() === '2:sql-unknown-table' ? sqlCodes() : undefined), 'table inconnue'), ['2:sql-unknown-table']);
    rmSync(path.join(fixture, '.vscode/php-forge-schema.json'));
    await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('.vscode/php-forge-schema.json'), type: 3 }] });
    await waitFor(() => (sqlCodes()?.join() === '1:sql-unknown-column' ? true : undefined), 'cache supprimé');
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('clients.php') } });
  });

  it('SQL : complétion des colonnes, « . » sans liste PHP hors requête', async () => {
    await open(server, 'complete.php', '<?php\n$r = mysqli_query($db, "SELECT c. FROM clients c");\n$t = $a.$b;\n');
    const list = (await server.connection.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('complete.php') }, position: { line: 1, character: 33 }, context: { triggerKind: 2, triggerCharacter: '.' },
    })) as { items: { label: string }[] };
    assert.deepEqual(list.items.map((i) => i.label), ['id', 'nom', 'solde']);
    const php = await server.connection.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('complete.php') }, position: { line: 2, character: 8 }, context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert.equal(php, null);
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('complete.php') } });
  });

  it('sécurité : donnée de la requête affichée sans échappement', async () => {
    await open(server, 'sec.php', '<?php\n$nom = $_GET["nom"];\necho "Bonjour " . $nom;\n');
    const found = await waitFor(() => server.diagnostics.get(uri('sec.php'))?.find((d) => d.code === 'security-xss'), 'security-xss');
    assert.equal(found.range.start.line, 2);
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('sec.php') } });
  });

  it('migration : version cible, diagnostics migration-* et rapport', { skip: !hasStubs }, async () => {
    await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: { phpForge: { phpVersion: '7.3', migration: { targetVersion: '8.0' } } } });
    await open(server, 'old.php', '<?php\nwhile (list($k, $v) = each($tab)) {}\n');
    const found = await waitFor(() => server.diagnostics.get(uri('old.php'))?.find((d) => d.code === 'migration-removed-api'), 'migration-removed-api');
    assert.equal(found.range.start.line, 1);
    const report = (await server.connection.sendRequest('phpForge/migrationReport')) as string;
    assert.match(report, /^# Migration report: PHP 7\.3 → PHP 8\.0/);
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('old.php') } });
    await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: { phpForge: {} } });
  });

  it('sécurité : la fonction d’un autre fichier apparue après l’ouverture est suivie sans frappe', async () => {
    await open(server, 'appel.php', '<?php\nafficher($_GET["v"]);\n');
    await waitFor(() => server.diagnostics.get(uri('appel.php')), 'premiers diagnostics');
    const lib = path.join(fixture, 'includes/afficher.php');
    writeFileSync(lib, '<?php\nfunction afficher($v)\n{\n    echo $v;\n}\n');
    try {
      await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('includes/afficher.php'), type: 1 }] });
      const found = await waitFor(() => server.diagnostics.get(uri('appel.php'))?.find((d) => d.code === 'security-xss'), 'security-xss après indexation');
      assert.equal(found.range.start.line, 1);
    } finally {
      rmSync(lib, { force: true });
      await server.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('includes/afficher.php'), type: 3 }] });
      await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: uri('appel.php') } });
    }
  });

  it('impact : pages qui atteignent un fichier modifié', async () => {
    const entries = (await server.connection.sendRequest('phpForge/impact', { uris: [uri('includes/footer.php'), uri('style.css')] })) as { label: string; pages: { label: string }[] }[];
    assert.deepEqual(entries.map((e) => [e.label, e.pages.map((p) => p.label)]), [['includes/footer.php', ['pages/about.php', 'pages/home.php']]]);
  });

  it('second démarrage : tout vient du cache', async () => {
    const second = await startServer(storage);
    try {
      assert.equal(second.indexed.stats.fromCache, 9);
      assert.equal(second.indexed.stats.parsed, 0);
    } finally {
      await stopServer(second);
    }
  });
});
