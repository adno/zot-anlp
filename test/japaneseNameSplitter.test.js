const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitJapaneseName,
  splitJapaneseNameWithLexicon
} = require('../src/services/japaneseNameSplitter');
const { inferLanguageFromTitle, toCreator } = require('../src/services/zoteroMapper');

test('splitJapaneseName splits no-space Japanese names with dictionary pair', () => {
  const split = splitJapaneseName('那須川哲哉');
  assert.ok(split);
  assert.equal(split.lastName, '那須川');
  assert.equal(split.firstName, '哲哉');
  assert.equal(split.method, 'dictionary_pair');
});

test('splitJapaneseName prefers 2+2 for 4-char ambiguity', () => {
  const surnames = new Set(['阿', '阿部', '阿部田']);
  const givens = new Set(['部田郎', '田郎', '郎']);
  const split = splitJapaneseNameWithLexicon('阿部田郎', surnames, givens);

  assert.ok(split);
  assert.equal(split.lastName, '阿部');
  assert.equal(split.firstName, '田郎');
  assert.equal(split.method, 'dictionary_pair');
});

test('splitJapaneseName falls back to greedy surname when pair is missing', () => {
  const surnames = new Set(['阿部', '阿部田']);
  const givens = new Set([]);
  const split = splitJapaneseNameWithLexicon('阿部田郎', surnames, givens);

  assert.ok(split);
  assert.equal(split.lastName, '阿部田');
  assert.equal(split.firstName, '郎');
  assert.equal(split.method, 'greedy_surname');
});

test('toCreator keeps single-field when no split is possible', () => {
  const creator = toCreator('𠮷');
  assert.equal(creator.firstName, '');
  assert.equal(creator.lastName, '𠮷');
});

test('inferLanguageFromTitle returns ja when title has Japanese characters', () => {
  assert.equal(inferLanguageFromTitle('日本語タイトル'), 'ja');
  assert.equal(inferLanguageFromTitle('Neural NLP と Transformer'), 'ja');
});

test('inferLanguageFromTitle returns en when title has no Japanese characters', () => {
  assert.equal(inferLanguageFromTitle('A Study on ANLP Metadata'), 'en');
  assert.equal(inferLanguageFromTitle('B2-3'), 'en');
});
