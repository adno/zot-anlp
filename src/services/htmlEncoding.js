function normalizeCharset(label) {
  if (!label) {
    return '';
  }

  const normalized = String(label).trim().toLowerCase();
  const aliases = {
    'utf8': 'utf-8',
    'shift-jis': 'shift_jis',
    'sjis': 'shift_jis',
    'x-sjis': 'shift_jis',
    'ms_kanji': 'shift_jis',
    'windows-31j': 'shift_jis',
    'cp932': 'shift_jis',
    'eucjp': 'euc-jp',
    'euc_jp': 'euc-jp',
    'iso2022jp': 'iso-2022-jp'
  };

  return aliases[normalized] || normalized;
}

function extractCharsetFromContentType(contentType) {
  if (!contentType) {
    return '';
  }

  const match = String(contentType).match(/charset\s*=\s*["']?\s*([a-z0-9._-]+)/i);
  return normalizeCharset(match ? match[1] : '');
}

function extractCharsetFromHtmlMeta(asciiHead) {
  if (!asciiHead) {
    return '';
  }

  const html = String(asciiHead);
  const metaCharset = html.match(/<meta[^>]*charset\s*=\s*["']?\s*([a-z0-9._-]+)/i);
  if (metaCharset) {
    return normalizeCharset(metaCharset[1]);
  }

  const metaContentType = html.match(
    /<meta[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i
  );
  return normalizeCharset(metaContentType ? metaContentType[1] : '');
}

function bytesToAscii(bytes, maxBytes = 8192) {
  const limit = Math.min(bytes.length, maxBytes);
  let out = '';
  for (let i = 0; i < limit; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function pickCharset(contentType, asciiHead) {
  const fromMeta = extractCharsetFromHtmlMeta(asciiHead);
  if (fromMeta) {
    return fromMeta;
  }

  return extractCharsetFromContentType(contentType) || 'utf-8';
}

function decodeHtmlBytes(bytes, contentType = '') {
  if (!(bytes instanceof Uint8Array)) {
    return '';
  }

  const asciiHead = bytesToAscii(bytes);
  const preferredCharset = pickCharset(contentType, asciiHead);

  try {
    return new TextDecoder(preferredCharset).decode(bytes);
  } catch (error) {
    // Fallbacks for environments that do not support the preferred label.
  }

  const fallbacks = ['utf-8', 'shift_jis', 'euc-jp', 'iso-2022-jp', 'windows-1252'];
  for (const charset of fallbacks) {
    if (charset === preferredCharset) {
      continue;
    }
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch (error) {
      // Try next fallback.
    }
  }

  return new TextDecoder().decode(bytes);
}

module.exports = {
  decodeHtmlBytes,
  extractCharsetFromContentType,
  extractCharsetFromHtmlMeta,
  normalizeCharset
};
