const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractPaperId,
  extractYearFromUrl,
  identifyAttachment
} = require('../src/services/matcher');

test('extractPaperId supports ANLP id patterns', () => {
  assert.equal(extractPaperId('B1-12.pdf'), 'B1-12');
  assert.equal(extractPaperId('path/to/c2-03.pdf'), 'C2-03');
  assert.equal(extractPaperId('paper.pdf'), null);
});

test('extractYearFromUrl reads annual_meeting year', () => {
  assert.equal(
    extractYearFromUrl('https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/B1-12.pdf'),
    2026
  );
  assert.equal(extractYearFromUrl('https://example.com/a.pdf'), null);
});

test('identifyAttachment combines title/url and default year', async () => {
  const attachment = {
    getField(name) {
      if (name === 'title') {
        return 'B1-12.pdf';
      }
      if (name === 'url') {
        return '';
      }
      return '';
    },
    async getFilePathAsync() {
      return '';
    }
  };

  const identified = await identifyAttachment(attachment, 2025);
  assert.equal(identified.paperId, 'B1-12');
  assert.equal(identified.year, 2025);
});
