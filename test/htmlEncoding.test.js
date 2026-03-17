const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeHtmlBytes } = require('../src/services/htmlEncoding');

function asciiBytes(text) {
  return Array.from(Buffer.from(text, 'ascii'));
}

test('decodeHtmlBytes prefers meta charset over content-type header', () => {
  const head = '<html><head><meta charset="windows-1252"></head><body>';
  const tail = '</body></html>';
  const bytes = Uint8Array.from([
    ...asciiBytes(head),
    0xe9, // é in windows-1252
    ...asciiBytes(tail)
  ]);

  const decoded = decodeHtmlBytes(bytes, 'text/html; charset=utf-8');
  assert.ok(decoded.includes('é'));
});

test('decodeHtmlBytes supports shift_jis declared in meta', (t) => {
  try {
    // Confirm the runtime supports this encoding label.
    new TextDecoder('shift_jis');
  } catch (error) {
    t.skip('shift_jis decoder is not available in this runtime');
    return;
  }

  const head = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>';
  const tail = '</body></html>';
  const bytes = Uint8Array.from([
    ...asciiBytes(head),
    0x82, 0xa0, // "あ" in Shift_JIS
    ...asciiBytes(tail)
  ]);

  const decoded = decodeHtmlBytes(bytes);
  assert.ok(decoded.includes('あ'));
});
