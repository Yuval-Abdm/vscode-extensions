// Serveur complet lancé comme par VS Code (stdio) sur le projet de test : indexation, cache, requêtes, robustesse.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
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
}

async function startServer(storagePath: string): Promise<Server> {
  const child = spawn(process.execPath, [path.join(pkg, 'dist/server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
  const diagnostics: Server['diagnostics'] = new Map();
  const indexed = new Promise<IndexedParams>((resolve) => connection.onNotification('phpForge/indexed', resolve));
  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    const p = params as { uri: string; diagnostics: Server['diagnostics'] extends Map<string, infer D> ? D : never };
    diagnostics.set(p.uri, p.diagnostics);
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
  return { child, connection, indexed: await indexed, diagnostics, statuses };
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
  after(async () => stopServer(server));

  it('indexe le projet et écrit le cache', () => {
    assert.deepEqual({ ...server.indexed.stats, ms: 0 }, { files: 5, parsed: 5, fromCache: 0, skipped: 0, syntaxErrors: 1, ms: 0 });
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
    assert.deepEqual(symbols.map((s) => s.name), ['Helper', 'BaseHelper']);
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

  it('« ; » manquant signalé, avec sa correction rapide', async () => {
    await open(server, 'semicolon.php', '<?php\n$a = 1\n$b = 2;\n');
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('semicolon.php')), 'diagnostics');
    assert.equal(diagnostics[0].code, 'missing-semicolon');
    const actions = (await server.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('semicolon.php') }, range: diagnostics[0].range, context: { diagnostics },
    })) as { edit: { changes: Record<string, { newText: string }[]> } }[];
    assert.equal(actions[0].edit.changes[uri('semicolon.php')][0].newText, ';');
  });

  it('requête SQL aux guillemets mélangés', async () => {
    await open(server, 'quotes.php', `<?php\n$sql = 'UPDATE t SET a'.$d." = '". $h ."' WHERE id = 1";\n`);
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('quotes.php')), 'diagnostics');
    assert.deepEqual(diagnostics.map((d) => d.code), ['sql-mixed-quotes', 'sql-mixed-quotes']);
  });

  it('valeur non affichée dans du HTML, avec ses corrections rapides', async () => {
    await open(server, 'tags.php', '<div><?$nom?></div>\n');
    const diagnostics = await waitFor(() => server.diagnostics.get(uri('tags.php')), 'diagnostics');
    assert.equal(diagnostics[0].code, 'useless-output');
    const actions = (await server.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('tags.php') }, range: diagnostics[0].range, context: { diagnostics },
    })) as { edit: { changes: Record<string, { newText: string }[]> } }[];
    assert.deepEqual(actions.map((a) => a.edit.changes[uri('tags.php')][0].newText), ['<?=', '<?php echo ']);
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

  it('second démarrage : tout vient du cache', async () => {
    const second = await startServer(storage);
    try {
      assert.equal(second.indexed.stats.fromCache, 5);
      assert.equal(second.indexed.stats.parsed, 0);
    } finally {
      await stopServer(second);
    }
  });
});
