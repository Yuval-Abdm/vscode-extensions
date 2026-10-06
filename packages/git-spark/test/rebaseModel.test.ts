import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  amendScript,
  buildTodo,
  cleanupMessage,
  parseTodo,
  serializeTodo,
  shellQuote,
  squashMessage,
  validateRebase,
  type Amend,
  type RebaseItem,
} from '../src/features/operations/rebaseModel.ts';

const item = (sha: string, action: RebaseItem['action'], message = `msg ${sha}`, newMessage?: string): RebaseItem => ({
  sha,
  summary: message.split('\n')[0],
  message,
  ident: `A <a@x> ${sha.charCodeAt(0)}`,
  action,
  newMessage,
});

describe('rebase interactif : modèle', () => {
  it('validation', () => {
    assert.equal(validateRebase([item('a', 'drop'), item('b', 'drop')]), 'empty');
    assert.equal(validateRebase([item('a', 'drop'), item('b', 'squash')]), 'squash-first');
    assert.equal(validateRebase([item('a', 'fixup')]), 'squash-first');
    assert.equal(validateRebase([item('a', 'pick'), item('b', 'squash')]), undefined);
  });

  it('message proposé pour un squash : tête du groupe (reformulée seulement si reword), squash du groupe, sans les fixup', () => {
    const items = [item('a', 'reword', 'A', 'A2'), item('b', 'fixup', 'B'), item('c', 'squash', 'C'), item('d', 'squash', 'D')];
    assert.equal(squashMessage(items, 2), 'A2\n\nC');
    assert.equal(squashMessage(items, 3), 'A2\n\nC\n\nD');
    // newMessage resté d'une ancienne action : ignoré pour une tête en pick.
    assert.equal(squashMessage([item('a', 'pick', 'A', 'stale'), item('b', 'squash', 'B')], 1), 'A\n\nB');
  });

  it('liste de tâches : reword et squash via un script, message attendu enchaîné, ordre conservé', () => {
    const items = [
      item('a', 'pick'),
      item('b', 'reword', 'B', 'B new'),
      item('c', 'squash', 'C', 'B new + C'),
      item('d', 'fixup'),
      item('e', 'edit'),
      item('f', 'drop'),
      item('g', 'reword', 'G', 'G  \n'),
    ];
    const amends: Amend[] = [];
    const todo = buildTodo(items, (amend) => {
      amends.push(amend);
      return `/tmp/x y/amend-${amend.index}.sh`;
    });
    assert.equal(
      todo,
      ['pick a', 'pick b', "exec sh '/tmp/x y/amend-1.sh'", 'fixup c', "exec sh '/tmp/x y/amend-2.sh'", 'fixup d', 'edit e', 'drop f', 'pick g'].join('\n'),
    );
    assert.deepEqual(
      amends.map((a) => [a.sha, a.ident, a.expected, a.message]),
      [
        ['b', items[1].ident, 'B', 'B new'],
        ['c', items[1].ident, 'B new', 'B new + C'],
      ],
    );
  });

  it('script : chemins et identité entre apostrophes, nettoyage des espaces seulement', () => {
    const script = amendScript({ index: 0, sha: 'abc', ident: "O'Brien <o@x> 1", expected: 'x', message: 'y' }, "/tmp/$x/it's.txt", '/tmp/e.txt');
    assert.ok(script.includes(`= 'O'\\''Brien <o@x> 1'`));
    assert.ok(script.includes(`-F '/tmp/$x/it'\\''s.txt'`));
    assert.ok(script.includes('--cleanup=whitespace'));
    assert.equal(shellQuote('a b'), "'a b'");
    assert.equal(cleanupMessage('\n\nTitle  \n\n\n\nBody\t\n# kept\n\n'), 'Title\n\nBody\n# kept');
  });

  it('git-rebase-todo : lecture (abréviations, commentaires) et écriture ; commandes non prises en charge', () => {
    const text = 'pick 1111111 First\nr 2222222 Second one\n\n# Rebase 0000..2222 onto 0000\n# Commands:\n';
    assert.deepEqual(parseTodo(text), [
      { action: 'pick', sha: '1111111', summary: 'First' },
      { action: 'reword', sha: '2222222', summary: 'Second one' },
    ]);
    assert.equal(serializeTodo([{ action: 'squash', sha: '2222222', summary: 'Second one' }, { action: 'pick', sha: '1111111', summary: 'First' }]), 'squash 2222222 Second one\npick 1111111 First\n');
    assert.equal(parseTodo('pick 1111111 A\nexec make test\n'), undefined);
    assert.equal(parseTodo('label onto\npick 1111111 A\n'), undefined);
  });
});
