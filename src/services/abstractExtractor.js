function normalizeHeadingText(text) {
  return String(text || '')
    .replace(/[\u3000\t]/g, ' ')
    .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

function isJapaneseText(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ''));
}

function isSectionHeading(line, language, preferDefaultTitle) {
  const normalized = normalizeHeadingText(line);
  if (!normalized) {
    return false;
  }

  if (language === 'ja') {
    if (preferDefaultTitle) {
      return /^1[\s.、．]+\s*はじめに\b/.test(normalized);
    }
    return /^1[\s.、．]+\S+/.test(normalized);
  }

  if (preferDefaultTitle) {
    return /^1[\s.]+\s*introduction\b/i.test(normalized);
  }
  return /^1[\s.]+\S+/.test(normalized);
}

function containsEmailAddress(line) {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(String(line || ''));
}

function findAbstractBoundsWithoutHeading(lines, language) {
  const maxEmailScan = Math.min(lines.length, 40);
  let emailIndex = -1;
  for (let i = 0; i < maxEmailScan; i += 1) {
    if (containsEmailAddress(lines[i])) {
      emailIndex = i;
      break;
    }
  }

  if (emailIndex < 0 || emailIndex + 1 >= lines.length) {
    return null;
  }

  const start = emailIndex + 1;
  let end = lines.length;
  let endMode = 'none';

  for (let i = start; i < lines.length; i += 1) {
    if (isSectionHeading(lines[i], language, true)) {
      end = i;
      endMode = 'preferred';
      break;
    }
  }

  if (end === lines.length) {
    for (let i = start; i < lines.length; i += 1) {
      if (isSectionHeading(lines[i], language, false)) {
        end = i;
        endMode = 'fallback';
        break;
      }
    }
  }

  if (end <= start || end - start > 20) {
    return null;
  }

  return {
    start,
    end,
    headingIndex: -1,
    endMode: `${endMode}-no-heading`,
    trigger: 'email'
  };
}

function findAbstractBounds(lines, language) {
  const headingPattern = language === 'ja'
    ? /^概要(?:\s*[:：]\s*(.*))?$/u
    : /^abstract(?:\s*[:：]\s*(.*))?$/iu;

  let start = -1;
  let headingIndex = -1;
  const normalizedLines = lines.map((line) => normalizeHeadingText(line));

  for (let i = 0; i < normalizedLines.length; i += 1) {
    const match = normalizedLines[i].match(headingPattern);
    if (!match) {
      continue;
    }

    const trailing = (match[1] || '').trim();
    if (trailing) {
      lines[i] = trailing;
      start = i;
    } else {
      start = i + 1;
    }
    headingIndex = i;
    break;
  }

  if (start < 0 || start >= lines.length) {
    return findAbstractBoundsWithoutHeading(lines, language);
  }

  let end = lines.length;
  let endMode = 'none';
  for (let i = start; i < lines.length; i += 1) {
    if (isSectionHeading(lines[i], language, true)) {
      end = i;
      endMode = 'preferred';
      break;
    }
  }

  if (end === lines.length) {
    for (let i = start; i < lines.length; i += 1) {
      if (isSectionHeading(lines[i], language, false)) {
        end = i;
        endMode = 'fallback';
        break;
      }
    }
  }

  if (end <= start) {
    return null;
  }

  return {
    start,
    end,
    headingIndex,
    endMode,
    trigger: 'heading'
  };
}

function normalizeJapaneseAbstract(lines) {
  const normalizedLines = lines
    .map((line) => String(line || '').trim())
    .filter(Boolean);

  let out = '';
  for (const line of normalizedLines) {
    if (!out) {
      out = line;
      continue;
    }

    if (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(line)) {
      out += ` ${line}`;
      continue;
    }

    out += line;
  }

  return out;
}

function normalizeEnglishAbstract(lines) {
  let out = '';

  for (const line of lines) {
    const cleaned = String(line || '')
      .replace(/\u00ad/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      continue;
    }

    if (!out) {
      out = cleaned;
      continue;
    }

    if (/-$/.test(out) && /^[A-Za-z]/.test(cleaned)) {
      out = out.slice(0, -1) + cleaned;
      continue;
    }

    out += ` ${cleaned}`;
  }

  return out.trim().replace(/\s+/g, ' ');
}

function previewLines(lines, maxLines = 8) {
  return lines
    .slice(0, maxLines)
    .join(' | ')
    .slice(0, 700);
}

function extractAbstractFromLines(inputLines, options = {}) {
  const debug = typeof options.debug === 'function' ? options.debug : null;
  const source = options.source || 'unknown';
  const lines = (inputLines || [])
    .map((line) => String(line || '').replace(/\r/g, '').trim())
    .filter(Boolean);
  if (lines.length === 0) {
    if (debug) {
      debug(`no non-empty lines from ${source}`);
    }
    return null;
  }

  const preferredOrder = ['ja', 'en'];
  let language = null;
  let bounds = null;

  for (const candidateLanguage of preferredOrder) {
    const candidateBounds = findAbstractBounds(lines.slice(), candidateLanguage);
    if (candidateBounds) {
      language = candidateLanguage;
      bounds = candidateBounds;
      break;
    }
  }

  if (!bounds) {
    const guessed = isJapaneseText(lines.join('\n')) ? 'ja' : 'en';
    if (debug) {
      debug(
        `abstract heading/bounds not found from ${source}; guessedLanguage=${guessed}; ` +
        `lines=${lines.length}; preview="${previewLines(lines)}"`
      );
    }
    return null;
  }

  const selectedLines = lines.slice(bounds.start, bounds.end);
  const abstractText = language === 'ja'
    ? normalizeJapaneseAbstract(selectedLines)
    : normalizeEnglishAbstract(selectedLines);
  if (!abstractText) {
    if (debug) {
      debug(`abstract normalized to empty from ${source}; selectedLines=${selectedLines.length}`);
    }
    return null;
  }

  if (debug) {
    debug(
      `abstract extracted from ${source}; language=${language}; headingLine=${bounds.headingIndex}; ` +
      `trigger=${bounds.trigger || 'unknown'}; ` +
      `start=${bounds.start}; end=${bounds.end}; endMode=${bounds.endMode}; ` +
      `selectedLines=${selectedLines.length}; chars=${abstractText.length}`
    );
  }

  return {
    text: abstractText,
    language
  };
}

function itemToText(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  if (typeof item.str === 'string') {
    return item.str;
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  return '';
}

function itemToPosition(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const transform = Array.isArray(item.transform) ? item.transform : null;
  const x = Number.isFinite(item.x)
    ? item.x
    : (transform && Number.isFinite(transform[4]) ? transform[4] : null);
  const y = Number.isFinite(item.y)
    ? item.y
    : (transform && Number.isFinite(transform[5]) ? transform[5] : null);
  const width = Number.isFinite(item.width) ? item.width : 0;
  const height = Number.isFinite(item.height) ? item.height : 0;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y, width, height };
}

function isLikelyCJKBoundary(left, right) {
  return /[\u3040-\u30ff\u3400-\u9fff]$/.test(left) || /^[\u3040-\u30ff\u3400-\u9fff]/.test(right);
}

function mergeLineItems(items) {
  return items
    .sort((a, b) => a.pos.x - b.pos.x)
    .reduce((acc, current) => {
      const part = current.text.trim();
      if (!part) {
        return acc;
      }
      if (!acc) {
        return part;
      }
      if (isLikelyCJKBoundary(acc, part)) {
        return `${acc}${part}`;
      }
      return `${acc} ${part}`;
    }, '')
    .trim();
}

function extractLinesFromPositionedItems(items, pageWidth) {
  const midpoint = Number.isFinite(pageWidth) ? pageWidth / 2 : null;
  const filtered = [];

  for (const item of items || []) {
    const text = itemToText(item);
    if (!text || !text.trim()) {
      continue;
    }
    const pos = itemToPosition(item);
    if (!pos) {
      continue;
    }

    if (midpoint !== null) {
      const centerX = pos.x + (pos.width / 2);
      if (centerX > midpoint) {
        continue;
      }
    }

    filtered.push({ text, pos });
  }

  filtered.sort((a, b) => {
    if (Math.abs(a.pos.y - b.pos.y) > 2) {
      return b.pos.y - a.pos.y;
    }
    return a.pos.x - b.pos.x;
  });

  const lines = [];
  for (const item of filtered) {
    const current = lines[lines.length - 1];
    if (!current) {
      lines.push({ y: item.pos.y, items: [item] });
      continue;
    }

    const tolerance = Math.max(2, Math.max(item.pos.height, current.items[0].pos.height) * 0.7);
    if (Math.abs(item.pos.y - current.y) <= tolerance) {
      current.items.push(item);
      continue;
    }

    lines.push({ y: item.pos.y, items: [item] });
  }

  return lines
    .map((line) => mergeLineItems(line.items))
    .filter(Boolean);
}

function getFirstPageText(fullText) {
  const normalized = String(fullText || '').replace(/\r/g, '');
  if (!normalized) {
    return '';
  }

  const pages = normalized.split(/\f/);
  return pages[0] || '';
}

function pickFirstPagePayload(payload) {
  if (!payload) {
    return null;
  }
  if (Array.isArray(payload)) {
    return pickFirstPagePayload(payload[0]);
  }
  if (typeof payload === 'string') {
    return { text: payload };
  }
  if (Array.isArray(payload.pages) && payload.pages.length > 0) {
    return pickFirstPagePayload(payload.pages[0]);
  }
  if (typeof payload.text === 'string') {
    return {
      text: payload.text,
      items: payload.items || payload.tokens || payload.chars || null,
      width: payload.width || payload.pageWidth || null
    };
  }
  if (Array.isArray(payload.items) || Array.isArray(payload.tokens) || Array.isArray(payload.chars)) {
    return {
      text: '',
      items: payload.items || payload.tokens || payload.chars,
      width: payload.width || payload.pageWidth || null
    };
  }
  return null;
}

async function getFirstPageCandidateFromPdfWorker(attachmentID) {
  if (
    typeof Zotero === 'undefined' ||
    !Zotero.PDFWorker ||
    typeof Zotero.PDFWorker.getFullText !== 'function'
  ) {
    return null;
  }

  const attempts = [
    () => Zotero.PDFWorker.getFullText(attachmentID, { maxPages: 1 }),
    () => Zotero.PDFWorker.getFullText(attachmentID, 1),
    () => Zotero.PDFWorker.getFullText(attachmentID)
  ];

  for (const run of attempts) {
    try {
      const result = await run();
      const firstPage = pickFirstPagePayload(result);
      if (firstPage) {
        return firstPage;
      }
    } catch (error) {
      // Keep trying fallbacks.
    }
  }

  return null;
}

async function getFirstPageCandidateFromFulltext(attachmentID) {
  if (
    typeof Zotero === 'undefined' ||
    !Zotero.Fulltext ||
    typeof Zotero.Fulltext.getItemText !== 'function'
  ) {
    return null;
  }

  try {
    const text = await Promise.resolve(Zotero.Fulltext.getItemText(attachmentID));
    const firstPageText = getFirstPageText(text);
    if (!firstPageText) {
      return null;
    }
    return { text: firstPageText };
  } catch (error) {
    return null;
  }
}

async function extractAbstractForAttachment(attachment, options = {}) {
  const debug = typeof options.debug === 'function' ? options.debug : null;
  if (!attachment || !attachment.id) {
    if (debug) {
      debug('attachment is missing or has no id');
    }
    return null;
  }

  const fromPdfWorker = await getFirstPageCandidateFromPdfWorker(attachment.id);
  if (fromPdfWorker) {
    if (debug) {
      debug(
        `PDFWorker candidate: hasItems=${Array.isArray(fromPdfWorker.items)} ` +
        `items=${Array.isArray(fromPdfWorker.items) ? fromPdfWorker.items.length : 0} ` +
        `hasText=${Boolean(fromPdfWorker.text)} width=${fromPdfWorker.width || 'n/a'}`
      );
    }
    if (Array.isArray(fromPdfWorker.items) && fromPdfWorker.items.length > 0) {
      const lines = extractLinesFromPositionedItems(fromPdfWorker.items, fromPdfWorker.width);
      const parsed = extractAbstractFromLines(lines, {
        debug,
        source: 'PDFWorker-positioned-left-column'
      });
      if (parsed && parsed.text) {
        return parsed.text;
      }

      const fullWidthLines = extractLinesFromPositionedItems(fromPdfWorker.items, null);
      const fullWidthParsed = extractAbstractFromLines(fullWidthLines, {
        debug,
        source: 'PDFWorker-positioned-full-page'
      });
      if (fullWidthParsed && fullWidthParsed.text) {
        return fullWidthParsed.text;
      }
    }

    if (fromPdfWorker.text) {
      const lines = fromPdfWorker.text.split(/\n+/);
      const parsed = extractAbstractFromLines(lines, {
        debug,
        source: 'PDFWorker-plain-text'
      });
      if (parsed && parsed.text) {
        return parsed.text;
      }
    }
  }

  if (debug) {
    debug('falling back to Zotero.Fulltext first-page text');
  }
  const fromFulltext = await getFirstPageCandidateFromFulltext(attachment.id);
  if (!fromFulltext || !fromFulltext.text) {
    if (debug) {
      debug('no first-page text from Zotero.Fulltext');
    }
    return null;
  }
  const lines = fromFulltext.text.split(/\n+/);
  const parsed = extractAbstractFromLines(lines, {
    debug,
    source: 'Zotero.Fulltext-first-page'
  });
  return parsed ? parsed.text : null;
}

module.exports = {
  extractAbstractFromLines,
  extractLinesFromPositionedItems,
  extractAbstractForAttachment
};
