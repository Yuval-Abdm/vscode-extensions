import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SymbolKind, SymbolTag } from 'vscode-languageserver/node';
import { documentSymbols } from '../src/server/features/documentSymbols.ts';
import { matchScore, workspaceSymbols } from '../src/server/features/workspaceSymbols.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extract } from './helpers.ts';

describe('documentSymbols', () => {
  it('plan hiérarchique, types LSP, propriétés avec $, obsolescence', async () => {
    const file = await extract('<?php class A { const C = 1; public $p; /** @deprecated */ function m() {} } function f() {} enum E { case X; }');
    const symbols = documentSymbols(file);
    assert.deepEqual(symbols.map((s) => [s.name, s.kind]), [['A', SymbolKind.Class], ['f', SymbolKind.Function], ['E', SymbolKind.Enum]]);
    assert.deepEqual(symbols[0].children!.map((s) => [s.name, s.kind]), [['C', SymbolKind.Constant], ['$p', SymbolKind.Property], ['m', SymbolKind.Method]]);
    assert.deepEqual(symbols[0].children![2].tags, [SymbolTag.Deprecated]);
    assert.deepEqual(symbols[2].children![0].kind, SymbolKind.EnumMember);
  });
});

describe('workspaceSymbols', () => {
  it('correspondance floue triée : exacte, préfixe, contenu, sous-séquence', async () => {
    const index = new SymbolIndex();
    index.set(await extract('<?php namespace App; class User {} class UserService { function getUser() {} } function usefulRecord() {} class Other {}', 'file:///a.php'));
    assert.deepEqual(workspaceSymbols(index, 'user').map((s) => s.name), ['User', 'UserService', 'getUser', 'usefulRecord']);
    assert.equal(workspaceSymbols(index, 'getuser')[0].containerName, 'App\\UserService');
    assert.equal(workspaceSymbols(index, 'User')[0].containerName, 'App');
    assert.equal(workspaceSymbols(index, 'User')[0].location.uri, 'file:///a.php');
  });

  it('requête vide : rien', async () => {
    const index = new SymbolIndex();
    index.set(await extract('<?php class A {}', 'file:///a.php'));
    assert.deepEqual(workspaceSymbols(index, '  '), []);
  });

  it('matchScore', () => {
    assert.equal(matchScore('user', 'user'), 100);
    assert.equal(matchScore('userservice', 'user'), 80);
    assert.equal(matchScore('getuser', 'user'), 60);
    assert.equal(matchScore('userecord', 'usrd'), 20);
    assert.equal(matchScore('other', 'user'), 0);
  });
});
