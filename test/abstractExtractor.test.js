const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAbstractFromLines,
  extractLinesFromPositionedItems
} = require('../src/services/abstractExtractor');

test('extractAbstractFromLines handles English heading and section boundary', () => {
  const lines = [
    'Some Header Text',
    'Abstract',
    'This paper presents a pro-',
    'cessing pipeline for ANLP papers.',
    'It improves extraction quality.',
    '1 Introduction',
    'Body starts here'
  ];

  const parsed = extractAbstractFromLines(lines);
  assert.ok(parsed);
  assert.equal(parsed.language, 'en');
  assert.equal(
    parsed.text,
    'This paper presents a processing pipeline for ANLP papers. It improves extraction quality.'
  );
});

test('extractAbstractFromLines falls back to English when Japanese chars exist', () => {
  const lines = [
    '松田 et al.',
    'Abstract',
    'We propose a pro-',
    'cessing method for ANLP tasks.',
    '1 Introduction'
  ];

  const parsed = extractAbstractFromLines(lines);
  assert.ok(parsed);
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.text, 'We propose a processing method for ANLP tasks.');
});

test('extractAbstractFromLines handles Japanese abstract and fallback section title', () => {
  const lines = [
    '著者情報',
    '概要',
    '本研究では自然言語処理のための手法を提案する。',
    '提案法は既存法より高い性能を示す。',
    '1 実験設定',
    '本文'
  ];

  const parsed = extractAbstractFromLines(lines);
  assert.ok(parsed);
  assert.equal(parsed.language, 'ja');
  assert.equal(
    parsed.text,
    '本研究では自然言語処理のための手法を提案する。提案法は既存法より高い性能を示す。'
  );
});

test('extractAbstractFromLines keeps intra-line spaces for Japanese and adds boundary spacing', () => {
  const lines = [
    '概要',
    '近年,大規模言語モデル (Large Language Model, LLM)',
    'BERT is used',
    '評価を行った。',
    '1 はじめに'
  ];

  const parsed = extractAbstractFromLines(lines);
  assert.ok(parsed);
  assert.equal(parsed.language, 'ja');
  assert.equal(
    parsed.text,
    '近年,大規模言語モデル (Large Language Model, LLM) BERT is used 評価を行った。'
  );
});

test('extractLinesFromPositionedItems keeps only left column items', () => {
  const items = [
    { str: 'Abstract', x: 40, y: 760, width: 40, height: 10 },
    { str: 'Left', x: 40, y: 740, width: 20, height: 10 },
    { str: 'column', x: 70, y: 740, width: 30, height: 10 },
    { str: 'Right', x: 350, y: 740, width: 30, height: 10 }
  ];

  const lines = extractLinesFromPositionedItems(items, 600);
  assert.deepEqual(lines, ['Abstract', 'Left column']);
});

test('extractAbstractFromLines supports legacy layout without abstract heading', () => {
  const lines = [
    '言語処理学会第17回年次大会(NLP2011)',
    '○浅石卓真, 影浦峡 (東大)',
    'asaishi@p.u-tokyo.ac.jp',
    '本研究では専門語彙を手がかりとした知識構成の展開方法を提案する。',
    '生命科学分野を対象に評価し有効性を確認した。',
    '1 はじめに',
    '近年, 多様な知識獲得手法が提案されている。'
  ];

  const parsed = extractAbstractFromLines(lines);
  assert.ok(parsed);
  assert.equal(parsed.language, 'ja');
  assert.equal(
    parsed.text,
    '本研究では専門語彙を手がかりとした知識構成の展開方法を提案する。生命科学分野を対象に評価し有効性を確認した。'
  );
});
