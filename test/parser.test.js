const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseProgramHtml, parseBiblioHtml } = require('../src/services/anlpParser');

function readFixture(file) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
}

test('parseProgramHtml extracts papers with ids and URLs', () => {
  const html = readFixture('2026_program.html');
  const papers = parseProgramHtml(html, 2026);

  assert.equal(papers.length, 2);
  assert.equal(papers[0].paperId, 'B1-12');
  assert.equal(
    papers[0].pdfUrl,
    'https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/B1-12.pdf'
  );
  assert.ok(papers[0].title.includes('大規模言語モデル'));
});

test('parseProgramHtml handles table layout used in some years', () => {
  const html = readFixture('2025_program.html');
  const papers = parseProgramHtml(html, 2025);

  assert.equal(papers.length, 1);
  assert.equal(papers[0].paperId, 'D3-07');
  assert.ok(papers[0].title.includes('対話要約'));
  assert.deepEqual(papers[0].authors, ['佐藤 次郎', '田中 未来']);
});

test('parseProgramHtml handles absolute URL PDF links', () => {
  const html = readFixture('2024_program.html');
  const papers = parseProgramHtml(html, 2024);

  assert.equal(papers.length, 1);
  assert.equal(papers[0].paperId, 'E4-02');
  assert.ok(papers[0].pdfUrl.endsWith('/2024/pdf_dir/E4-02.pdf'));
});

test('parseBiblioHtml extracts proceedings title and place', () => {
  const html = readFixture('2026_biblio.html');
  const conference = parseBiblioHtml(html, 2026);

  assert.equal(conference.publisher, '言語処理学会');
  assert.ok(conference.proceedingsTitle.includes('第32回年次大会'));
  assert.equal(conference.place, 'オンライン開催');
});

test('parseBiblioHtml supports place format with 於', () => {
  const html = readFixture('2025_biblio.html');
  const conference = parseBiblioHtml(html, 2025);

  assert.ok(conference.proceedingsTitle.includes('第31回年次大会'));
  assert.equal(conference.place, '出島メッセ長崎');
});
