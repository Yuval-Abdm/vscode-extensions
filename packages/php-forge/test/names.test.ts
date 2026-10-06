import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newScope, resolveClassName, resolveFunctionOrConstant, scopeAt } from '../src/server/model/names.ts';
import type { NameScope, Range } from '../src/shared/types.ts';

const lines = (from: number, to: number): Range => ({ start: { line: from, character: 0 }, end: { line: to, character: 0 } });

function scope(namespace: string, uses: Partial<NameScope['uses']> = {}): NameScope {
  const s = newScope(namespace, lines(0, 100));
  Object.assign(s.uses, uses);
  return s;
}

const app = scope('App', { class: { baz: 'Foo\\Bar' }, function: { helper: 'Lib\\helper' }, constant: { MAX: 'Lib\\MAX' } });

describe('resolveClassName', () => {
  it('préfixe le namespace courant', () => assert.equal(resolveClassName('User', app), 'App\\User'));
  it('nom complet', () => assert.equal(resolveClassName('\\Foo\\Bar', app), 'Foo\\Bar'));
  it('alias use, sans casse, y compris comme préfixe', () => {
    assert.equal(resolveClassName('BAZ', app), 'Foo\\Bar');
    assert.equal(resolveClassName('Baz\\Sub', app), 'Foo\\Bar\\Sub');
  });
  it('namespace\\ relatif', () => assert.equal(resolveClassName('namespace\\Sub\\X', app), 'App\\Sub\\X'));
  it('self, static, parent et types natifs : rien', () => {
    for (const name of ['self', 'static', 'parent', 'int', 'string', 'mixed']) assert.equal(resolveClassName(name, app), undefined);
  });
  it('namespace global', () => assert.equal(resolveClassName('User', scope('')), 'User'));
});

describe('resolveFunctionOrConstant', () => {
  it('namespace courant puis global', () => assert.deepEqual(resolveFunctionOrConstant('strlen', 'function', app), ['App\\strlen', 'strlen']));
  it('use function, sans casse', () => assert.deepEqual(resolveFunctionOrConstant('Helper', 'function', app), ['Lib\\helper']));
  it('use const, avec casse', () => {
    assert.deepEqual(resolveFunctionOrConstant('MAX', 'constant', app), ['Lib\\MAX']);
    assert.deepEqual(resolveFunctionOrConstant('max', 'constant', app), ['App\\max', 'max']);
  });
  it('nom complet', () => assert.deepEqual(resolveFunctionOrConstant('\\strlen', 'function', app), ['strlen']));
  it('nom qualifié via un alias de classe', () => assert.deepEqual(resolveFunctionOrConstant('Baz\\f', 'function', app), ['Foo\\Bar\\f']));
  it('namespace global', () => assert.deepEqual(resolveFunctionOrConstant('f', 'function', scope('')), ['f']));
});

describe('scopeAt', () => {
  it('la dernière portée qui contient la position', () => {
    const file = newScope('', lines(0, 50));
    const block = newScope('A', lines(10, 20));
    assert.equal(scopeAt([file, block], { line: 15, character: 0 }), block);
    assert.equal(scopeAt([file, block], { line: 30, character: 0 }), file);
  });
});
