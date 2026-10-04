import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { docMethods, docMixins, docParams, docParents, docProperties, docReturn, docSummary, docTemplates, docVar, splitType } from '../src/server/model/phpdoc.ts';
import { newScope } from '../src/server/model/names.ts';
import { typeFromNode } from '../src/server/types/declType.ts';
import { parseDocType } from '../src/server/types/docType.ts';
import { classType, formatType, MIXED, scalar, union, withoutNull } from '../src/server/types/type.ts';
import { parse } from './helpers.ts';

const scope = newScope('App', { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } });
scope.uses.class.user = 'Lib\\User';
const show = (text: string, templates: string[] = []) => {
  const type = parseDocType(text, scope, templates);
  return type && formatType(type);
};

describe('parseDocType', () => {
  it('scalaires, nullable, unions', () => {
    assert.equal(show('int|string'), 'int|string');
    assert.equal(show('?User'), '?User');
    assert.equal(show('null|User'), '?User');
    assert.equal(show('bool'), 'bool');
  });

  it('classes résolues avec les use et le namespace', () => {
    assert.deepEqual(parseDocType('User', scope), { kind: 'class', fqn: 'Lib\\User' });
    assert.deepEqual(parseDocType('Model', scope), { kind: 'class', fqn: 'App\\Model' });
    assert.deepEqual(parseDocType('\\DateTime', scope), { kind: 'class', fqn: 'DateTime' });
  });

  it('tableaux et génériques', () => {
    assert.equal(show('User[]'), 'User[]');
    assert.equal(show('array<int, User>'), 'array<int, User>');
    assert.equal(show('array<User>'), 'User[]');
    assert.equal(show('list<string>'), 'list<string>');
    assert.equal(show('iterable<User>'), 'User[]');
    assert.equal(show('Collection<User>'), 'Collection<User>');
    assert.equal(show('(int|string)[]'), '(int|string)[]');
  });

  it('formes array{…}', () => {
    assert.equal(show("array{id: int, 'name'?: string, tags: string[]}"), 'array{id: int, name: string, tags: string[]}');
  });

  it('class-string, callable, Closure, littéraux, pseudo-types, $this', () => {
    assert.equal(show('class-string<User>'), 'class-string<User>');
    assert.equal(show('callable(int): string'), 'callable');
    assert.equal(show('Closure(int): User'), 'Closure');
    assert.equal(show("'a'|'b'"), 'string');
    assert.equal(show('1|2'), 'int');
    assert.equal(show('positive-int'), 'int');
    assert.equal(show('non-empty-string'), 'string');
    assert.equal(show('$this'), 'static');
    assert.equal(show('mixed'), 'mixed');
  });

  it('templates', () => {
    assert.deepEqual(parseDocType('T', scope, ['T']), { kind: 'template', name: 'T' });
    assert.deepEqual(parseDocType('class-string<T>', scope, ['T']), { kind: 'classString', template: 'T' });
  });

  it('texte incompris : undefined', () => {
    assert.equal(parseDocType('array<int', scope), undefined);
    assert.equal(parseDocType('', scope), undefined);
    assert.equal(parseDocType('int string', scope), undefined);
  });
});

describe('opérations sur les types', () => {
  it('union aplatie, sans doublon, mixed ignoré à côté de types connus', () => {
    assert.deepEqual(union(scalar('int'), union(scalar('int'), scalar('string'))), { kind: 'union', types: [scalar('int'), scalar('string')] });
    assert.deepEqual(union(MIXED, scalar('int')), scalar('int'));
    assert.deepEqual(union(), MIXED);
  });

  it('retrait de null', () => {
    assert.deepEqual(withoutNull(union(classType('A'), scalar('null'))), classType('A'));
    assert.deepEqual(withoutNull(scalar('null')), scalar('null'));
  });
});

describe('typeFromNode', () => {
  it('types déclarés : nullable, union, intersection, static', async () => {
    const tree = await parse('<?php function f(?int $a, A|null $b, A&B $c): static {}');
    const fn = tree.rootNode.namedChildren[1];
    const types = fn.childForFieldName('parameters')!.namedChildren.map((p) => formatType(typeFromNode(p.childForFieldName('type'), scope)!));
    assert.deepEqual(types, ['?int', '?A', 'A&B']);
    assert.equal(formatType(typeFromNode(fn.childForFieldName('return_type'), scope)!), 'static');
  });
});

describe('balises phpdoc', () => {
  const DOC = [
    'Summary line.',
    'More.',
    '@param int $a First',
    '  continued <b>here</b>',
    '@param string|null ...$rest',
    '@phpstan-param list<int> $a',
    '@return array<int, User> the list',
    '@var Foo $x',
    '@template T of Model',
    '@extends Base<T>',
    '@mixin Helper',
    '@property-read int $id identifier',
    '@method static User find(int $id, bool $strict = false) Finds',
    '@method void reset()',
  ].join('\n');

  it('résumé', () => assert.equal(docSummary(DOC), 'Summary line.\nMore.'));

  it('@param : type, description sur plusieurs lignes, variantes phpstan prioritaires', () => {
    const params = docParams(DOC);
    assert.deepEqual(params.get('a'), { type: 'list<int>', description: 'First continued here' });
    assert.deepEqual(params.get('rest'), { type: 'string|null' });
  });

  it('@return, @var, @template, @extends, @mixin', () => {
    assert.equal(docReturn(DOC), 'array<int, User>');
    assert.deepEqual(docVar(DOC), [{ type: 'Foo', name: 'x' }]);
    assert.deepEqual(docTemplates(DOC), ['T']);
    assert.deepEqual(docParents(DOC), ['Base<T>']);
    assert.deepEqual(docMixins(DOC), ['Helper']);
  });

  it('@property et @method', () => {
    assert.deepEqual(docProperties(DOC), [{ name: 'id', type: 'int', description: 'identifier' }]);
    assert.deepEqual(docMethods(DOC), [
      { name: 'find', returns: 'User', isStatic: true, params: ['int $id', 'bool $strict = false'], description: 'Finds' },
      { name: 'reset', returns: 'void', isStatic: false, params: [] },
    ]);
  });

  it('splitType : génériques, formes et unions avec espaces', () => {
    assert.deepEqual(splitType('array<int, string> $x rest'), ['array<int, string>', '$x rest']);
    assert.deepEqual(splitType('array{a: int, b: string} $y'), ['array{a: int, b: string}', '$y']);
    assert.deepEqual(splitType('int | string $z'), ['int | string', '$z']);
    assert.deepEqual(splitType('callable(int): string $f'), ['callable(int): string', '$f']);
  });
});
