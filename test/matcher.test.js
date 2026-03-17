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
  assert.equal(extractPaperId('B10-4.pdf'), 'B10-4');
  assert.equal(extractPaperId('paper.pdf'), null);
});

test('extractYearFromUrl reads annual_meeting year', () => {
  assert.equal(
    extractYearFromUrl('https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/B1-12.pdf'),
    2026
  );
  assert.equal(extractYearFromUrl('https://example.com/a.pdf'), null);
});

test('identifyAttachment rejects non-ANLP URL domain', async () => {
  const attachment = {
    getField(name) {
      if (name === 'title') {
        return 'B1-12.pdf';
      }
      if (name === 'url') {
        return 'https://example.com/B1-12.pdf';
      }
      return '';
    },
    async getFilePathAsync() {
      return '';
    }
  };

  const identified = await identifyAttachment(attachment);
  assert.equal(identified.paperId, null);
  assert.equal(identified.year, null);
  assert.equal(identified.reasonCode, 'url_not_anlp_domain');
});

test('identifyAttachment requires strict filename when URL is absent', async () => {
  const attachment = {
    getField(name) {
      if (name === 'title') {
        return 'anlp_B1-12_final.pdf';
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

  const identified = await identifyAttachment(attachment);
  assert.equal(identified.paperId, null);
  assert.equal(identified.reasonCode, 'strict_filename_required_no_url');
});

test('identifyAttachment allows ANLP URL with loose filename', async () => {
  const attachment = {
    getField(name) {
      if (name === 'title') {
        return 'anlp_B1-12_final.pdf';
      }
      if (name === 'url') {
        return 'https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/anlp_B1-12_final.pdf';
      }
      return '';
    },
    async getFilePathAsync() {
      return '';
    }
  };

  const identified = await identifyAttachment(attachment);
  assert.equal(identified.paperId, 'B1-12');
  assert.equal(identified.year, 2026);
  assert.equal(identified.reasonCode, '');
});
