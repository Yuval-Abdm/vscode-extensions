import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTodo, parseTodo, serializeTodo, squashMessage, validateRebase, type RebaseItem } from '../src/features/operations/rebaseModel.ts';

const item = (sha: string, action: RebaseItem['action'], message = `msg ${sha}`, newMessage?: string): RebaseItem => ({
  sha,
  summary: message.split('\n')[0],
  message,
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

  it('message proposé pour un squash : tête du groupe (éventuellement reformulée) et squash précédents, sans les fixup', () => {
    const items = [item('a', 'reword', 'A', 'A2'), item('b', 'fixup', 'B'), item('c', 'squash', 'C'), item('d', 'squash', 'D')];
    assert.equal(squashMessage(items, 2), 'A2\n\nC');
    assert.equal(squashMessage(items, 3), 'A2\n\nC\n\nD');
  });

  it('liste de tâches : reword et squash via exec, ordre conservé', () => {
    const items = [
      item('a', 'pick'),
      item('b', 'reword', 'B', 'B new'),
      item('c', 'squash', 'C', 'B new + C'),
      item('d', 'fixup'),
      item('e', 'edit'),
      item('f', 'drop'),
      item('g', 'reword', 'G', 'G'),
    ];
    const files: string[] = [];
    const todo = buildTodo(items, (index, message) => {
      files.push(`${index}:${message}`);
      return `/tmp/m${index}`;
    });
    assert.equal(
      todo,
      [
        'pick a',
        'pick b',
        'exec git commit --amend --allow-empty --quiet -F "/tmp/m1"',
        'fixup c',
        'exec git commit --amend --allow-empty --quiet -F "/tmp/m2"',
        'fixup d',
        'edit e',
        'drop f',
        'pick g',
      ].join('\n'),
    );
    assert.deepEqual(files, ['1:B new', '2:B new + C']);
  });

  it('git-rebase-todo : lecture (abréviations, commentaires) et écriture ; commandes non prises en charge', () => {
    const text = 'pick 1111111 First\nr 2222222 Second one\n\n# Rebase 0000..2222 onto 0000\n# Commands:\n';
    const items = parseTodo(text);
    assert.deepEqual(items, [
      { action: 'pick', sha: '1111111', summary: 'First' },
      { action: 'reword', sha: '2222222', summary: 'Second one' },
    ]);
    assert.equal(serializeTodo([{ action: 'squash', sha: '2222222', summary: 'Second one' }, { action: 'pick', sha: '1111111', summary: 'First' }]), 'squash 2222222 Second one\npick 1111111 First\n');
    assert.equal(parseTodo('pick 1111111 A\nexec make test\n'), undefined);
    assert.equal(parseTodo('label onto\npick 1111111 A\n'), undefined);
  });
});
