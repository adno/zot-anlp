'use strict';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'zotanlp-year-cache-v4.json';
const PREF_PREFIX = 'extensions.zotanlp.';
const LEGACY_PREF_PREFIX = 'extensions.zot-anlp-metadata.';
const PLUGIN_TITLE = 'ZotANLP';
const MENU_LABEL = 'ZotANLP: Add Metadata From Web';
const PREFS_PANE_PLUGIN_ID = 'zot-anlp-metadata@local';

let toolsMenuItem = null;
let contextMenuItem = null;
let notifierID = null;
let menuRetryTimer = null;
let menuRetryCount = 0;
let autoEnrichTimer = null;
const pendingAutoItemIDs = new Set();
let loadedFromDisk = false;
let addonRootURI = '';
let prefsPaneRegistered = false;

const MAX_MENU_RETRIES = 20;
const cacheByYear = new Map();

function log(message, error) {
  const prefix = '[zot-anlp-metadata]';
  if (typeof Zotero !== 'undefined' && Zotero.debug) {
    Zotero.debug(`${prefix} ${message}`);
    if (error && Zotero.logError) {
      Zotero.logError(error);
    }
  }
}

function notify(message) {
  try {
    if (typeof Zotero !== 'undefined' && Zotero.alert) {
      Zotero.alert(null, PLUGIN_TITLE, message);
      return;
    }
    if (typeof Services !== 'undefined' && Services.prompt) {
      Services.prompt.alert(null, PLUGIN_TITLE, message);
    }
  } catch (error) {
    log('Notification failed', error);
  }
}

function getPref(key, fallback) {
  const prefName = `${PREF_PREFIX}${key}`;
  const legacyPrefName = `${LEGACY_PREF_PREFIX}${key}`;
  const value = Zotero.Prefs.get(prefName, true);
  const legacyValue = Zotero.Prefs.get(legacyPrefName, true);
  if (value === undefined || value === null || value === '') {
    if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') {
      return legacyValue;
    }
    return fallback;
  }
  return value;
}

function hasPrefValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function migrateAndInitializePrefs() {
  if (!Zotero || !Zotero.Prefs) {
    return;
  }

  const defaults = {
    autoEnrich: true,
    defaultYear: new Date().getFullYear(),
    overwriteMode: 'missing',
    extractAbstract: true
  };

  for (const [key, fallback] of Object.entries(defaults)) {
    const currentName = `${PREF_PREFIX}${key}`;
    const legacyName = `${LEGACY_PREF_PREFIX}${key}`;
    const currentValue = Zotero.Prefs.get(currentName, true);
    const legacyValue = Zotero.Prefs.get(legacyName, true);

    if (hasPrefValue(currentValue)) {
      continue;
    }

    if (hasPrefValue(legacyValue)) {
      Zotero.Prefs.set(currentName, legacyValue, true);
      continue;
    }

    Zotero.Prefs.set(currentName, fallback, true);
  }
}

function getDefaultYear() {
  const y = Number(getPref('defaultYear', new Date().getFullYear()));
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

function getOverwriteMode() {
  const mode = String(getPref('overwriteMode', 'missing'));
  return mode === 'overwrite' ? 'overwrite' : 'missing';
}

function getAutoEnrich() {
  return Boolean(getPref('autoEnrich', true));
}

function getExtractAbstract() {
  return Boolean(getPref('extractAbstract', true));
}

function previewLines(lines, maxLines = 8) {
  return lines
    .slice(0, maxLines)
    .join(' | ')
    .slice(0, 700);
}

function getCachePath() {
  if (typeof PathUtils === 'undefined' || !Zotero.Profile || !Zotero.Profile.dir) {
    return null;
  }
  return PathUtils.join(Zotero.Profile.dir, CACHE_FILE_NAME);
}

async function loadDiskCache() {
  if (loadedFromDisk) {
    return;
  }
  loadedFromDisk = true;

  const cachePath = getCachePath();
  if (!cachePath || typeof IOUtils === 'undefined') {
    return;
  }

  try {
    const json = await IOUtils.readUTF8(cachePath);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    for (const [year, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || !entry.createdAt || !entry.data) {
        continue;
      }
      cacheByYear.set(String(year), {
        createdAt: Number(entry.createdAt),
        data: entry.data
      });
    }
  } catch (error) {
    // Optional file.
  }
}

async function writeDiskCache() {
  const cachePath = getCachePath();
  if (!cachePath || typeof IOUtils === 'undefined') {
    return;
  }

  const obj = {};
  for (const [year, entry] of cacheByYear.entries()) {
    obj[year] = entry;
  }

  await IOUtils.writeUTF8(cachePath, JSON.stringify(obj));
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAuthors(text) {
  if (!text) {
    return [];
  }
  return text
    .split(/[、,，;；・]/)
    .map((token) => token
      .replace(/^[○〇\*]+/, '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
}

function splitAuthorsAndTitle(text) {
  if (!text) {
    return { authors: [], title: '' };
  }

  const cleaned = text.replace(/^\s*[A-Z]{1,2}\d-\d{1,2}\s*/, '').trim();
  const separators = ['：', ':'];

  for (const sep of separators) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0) {
      const authorsText = cleaned.slice(0, idx).trim();
      const title = cleaned.slice(idx + 1).trim();
      return { authors: splitAuthors(authorsText), title };
    }
  }

  return { authors: [], title: cleaned };
}

function htmlToTextLines(html) {
  const withBreaks = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|tr|div|td|th|h1|h2|h3|h4|h5|h6)>/gi, '\n');

  return withBreaks
    .split(/\n+/)
    .map((line) => stripTags(line))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeTitle(title, paperId) {
  if (!title) {
    return paperId;
  }
  return title
    .replace(/\bPDF\b/gi, '')
    .replace(/\(\s*pdf\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || paperId;
}

function looksLikeAuthorList(text) {
  if (!text) {
    return false;
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return false;
  }
  if (/[○〇]/.test(compact)) {
    return true;
  }
  if (/（[^）]+）|\([^)]{2,}\)/.test(compact)) {
    return true;
  }
  const delimCount = (compact.match(/[、,，;；・]/g) || []).length;
  return delimCount >= 2 && !/[：:]/.test(compact);
}

function cleanCandidateText(text, paperId) {
  return String(text || '')
    .replace(new RegExp(`\\b${paperId}\\b`, 'ig'), ' ')
    .replace(/\b(pdf|download)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractContext(html, index) {
  const start = Math.max(0, index - 5000);
  const end = Math.min(html.length, index + 5000);
  return html.slice(start, end);
}

function normalizeTitleLine(line, paperId) {
  return String(line || '')
    .replace(new RegExp(`\\b${paperId}\\b`, 'i'), '')
    .replace(/^\s*\([^)]{1,12}\)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRawAuthorLine(line) {
  return String(line || '')
    .replace(/^Image\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeTitleCandidate(text) {
  const s = String(text || '').trim();
  if (!s) {
    return false;
  }
  if (looksLikeAuthorList(s)) {
    return false;
  }
  if (/^(pdf|download)$/i.test(s)) {
    return false;
  }
  if (/^(Top|本会議|チュートリアル|ワークショップ|書誌情報)$/i.test(s)) {
    return false;
  }
  return s.length >= 6;
}

function parseAuthorsAndTitleFromContext(contextHtml, paperId) {
  const lines = htmlToTextLines(contextHtml);
  const cleanedLines = lines.map((line) => cleanCandidateText(line, paperId));
  const idRegex = new RegExp(`\\b${paperId}\\b`, 'i');
  const idLineIndex = lines.findIndex((line) => idRegex.test(line));

  let authors = [];
  let rawAuthors = '';
  let title = '';

  if (idLineIndex >= 0) {
    const idLine = normalizeTitleLine(lines[idLineIndex], paperId);
    if (/[：:]/.test(idLine)) {
      const parts = idLine.split(/[：:]/);
      const left = parts[0] ? parts[0].trim() : '';
      const right = parts.slice(1).join(':').trim();
      if (looksLikeAuthorList(left)) {
        rawAuthors = normalizeRawAuthorLine(left);
        authors = splitAuthors(rawAuthors);
      }
      if (right) {
        title = normalizeTitle(right, paperId);
      }
    } else {
      title = normalizeTitle(idLine, paperId);
    }
    for (let i = idLineIndex + 1; i < Math.min(cleanedLines.length, idLineIndex + 6); i += 1) {
      const candidate = cleanedLines[i];
      if (looksLikeAuthorList(candidate)) {
        rawAuthors = normalizeRawAuthorLine(candidate);
        authors = splitAuthors(rawAuthors);
        break;
      }
    }
  }

  if (!title || looksLikeAuthorList(title)) {
    const titleCandidate = lines.find((line) => idRegex.test(line) && !looksLikeAuthorList(line));
    if (titleCandidate) {
      title = normalizeTitle(normalizeTitleLine(titleCandidate, paperId), paperId);
    }
  }

  if ((!title || title === paperId) && idLineIndex >= 0) {
    for (let i = idLineIndex + 1; i < Math.min(lines.length, idLineIndex + 8); i += 1) {
      const candidate = normalizeTitleLine(lines[i], paperId);
      if (looksLikeTitleCandidate(candidate)) {
        title = normalizeTitle(candidate, paperId);
        break;
      }
    }
  }

  if (!authors.length) {
    const authorCandidate = cleanedLines
      .filter((t) => looksLikeAuthorList(t))
      .sort((a, b) => b.length - a.length)[0];
    if (authorCandidate) {
      rawAuthors = normalizeRawAuthorLine(authorCandidate);
      authors = splitAuthors(rawAuthors);
    }
  }

  if (!title) {
    const fallback = splitAuthorsAndTitle(`${paperId} ${cleanedLines.join(' ')}`);
    if (!authors.length) {
      authors = fallback.authors;
    }
    if (!rawAuthors) {
      rawAuthors = normalizeRawAuthorLine(cleanedLines.find((line) => looksLikeAuthorList(line)) || '');
    }
    title = normalizeTitle(fallback.title, paperId);
  }

  return {
    authors,
    rawAuthors,
    title
  };
}

function parseProgramHtml(html, year) {
  const papers = [];
  const re = /<a[^>]*href=["']([^"']*pdf_dir\/([A-Z]{1,2}\d-\d{1,2})\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titleById = new Map();

  const titleRe = /<span[^>]*id=["']([A-Z]{1,2}\d-\d{1,2})[^"']*["'][^>]*>[\s\S]*?<\/span>[\s\S]*?<span[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  let titleMatch;
  while ((titleMatch = titleRe.exec(html)) !== null) {
    const id = titleMatch[1].toUpperCase();
    const titleText = normalizeTitle(stripTags(titleMatch[2]), id);
    if (titleText) {
      titleById.set(id, titleText);
    }
  }

  function normalizePdfUrl(href) {
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
    if (href.startsWith('/')) {
      return `https://www.anlp.jp${href}`;
    }
    return `https://www.anlp.jp/proceedings/annual_meeting/${year}/${href.replace(/^\/+/, '')}`;
  }

  function extractRawAuthorsFromContext(contextHtml) {
    const rows = String(contextHtml).match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdRe.exec(row)) !== null) {
        cells.push(stripTags(tdMatch[1] || '').replace(/\s+/g, ' ').trim());
      }
      for (const cell of cells) {
        if (looksLikeAuthorList(cell)) {
          return normalizeRawAuthorLine(cell);
        }
      }
    }
    return '';
  }

  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const paperId = match[2].toUpperCase();

    const contextHtml = extractContext(html, match.index);
    const parsed = parseAuthorsAndTitleFromContext(contextHtml, paperId);
    const rawAuthors = parsed.rawAuthors || extractRawAuthorsFromContext(contextHtml);
    const authors = rawAuthors ? splitAuthors(rawAuthors) : parsed.authors;
    const title = titleById.get(paperId) || parsed.title;

    papers.push({
      paperId,
      year,
      title,
      authors,
      rawAuthors,
      pdfUrl: normalizePdfUrl(href),
      programUrl: `https://www.anlp.jp/proceedings/annual_meeting/${year}/`
    });
  }

  const dedup = new Map();
  for (const paper of papers) {
    if (!dedup.has(paper.paperId)) {
      dedup.set(paper.paperId, paper);
    }
  }
  return Array.from(dedup.values());
}

function parseBiblioHtml(html, year) {
  const fallbackProceedingsTitle = `言語処理学会第${String(year).slice(2)}回年次大会 発表論文集`;

  if (!html) {
    return {
      conferenceName: '',
      proceedingsTitle: fallbackProceedingsTitle,
      publisher: '言語処理学会',
      place: ''
    };
  }

  const htmlOneLine = String(html).replace(/\r?\n/g, ' ');
  const lines = htmlToTextLines(html);
  const start = lines.findIndex((line) => line === '本会議');
  const end = lines.findIndex((line, idx) => idx > start && line === 'チュートリアル');
  const scope = start >= 0
    ? lines.slice(start, end > start ? end : lines.length)
    : lines;

  const tableProceedingsMatch = htmlOneLine.match(
    /<t[hd][^>]*>\s*論文集\s*<\/t[hd]>\s*<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/i
  );
  const tablePlaceMatch = htmlOneLine.match(
    /<t[hd][^>]*>\s*(会場|開催場所|場所|於)\s*<\/t[hd]>\s*<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/i
  );

  const proceedingsLine = scope.find((line) =>
    /言語処理学会第\d+回年次大会/.test(line) && /(発表)?論文集/.test(line)
  ) || '';
  const placeLine = scope.find((line) => /^会場\s*[:：]?\s*/.test(line)) || '';

  const place = (tablePlaceMatch ? stripTags(tablePlaceMatch[2] || '') : placeLine)
    .replace(/^(会場|開催場所|場所|於)\s*[:：]?\s*/, '')
    .replace(/(Top|本会議|チュートリアル|ワークショップ|書誌情報).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const proceedingsTitle = (
    tableProceedingsMatch ? stripTags(tableProceedingsMatch[1] || '') :
      proceedingsLine || fallbackProceedingsTitle
  )
    .replace(/\s*\(NLP\d+\)\s*/g, ' ')
    .replace(/(Top|本会議|チュートリアル|ワークショップ|書誌情報).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    conferenceName: '',
    proceedingsTitle,
    publisher: '言語処理学会',
    place
  };
}

async function fetchText(url) {
  const response = await Zotero.HTTP.request('GET', url);
  return response.responseText;
}

async function getYearData(year, forceRefresh = false) {
  await loadDiskCache();

  const key = String(year);
  if (!forceRefresh && cacheByYear.has(key)) {
    const cached = cacheByYear.get(key);
    if (Date.now() - cached.createdAt <= CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const programURL = `https://www.anlp.jp/proceedings/annual_meeting/${year}/`;
  const biblioURL = `https://www.anlp.jp/proceedings/annual_meeting/${year}/html/biblio.html`;

  const programHtml = await fetchText(programURL);
  let biblioHtml = '';
  try {
    biblioHtml = await fetchText(biblioURL);
  } catch (error) {
    biblioHtml = '';
  }

  const data = {
    papers: parseProgramHtml(programHtml, year),
    conference: parseBiblioHtml(biblioHtml, year)
  };

  cacheByYear.set(key, { createdAt: Date.now(), data });
  await writeDiskCache().catch(() => {});
  return data;
}

const PAPER_ID_REGEX = /([A-Z]{1,2}\d-\d{1,2})/i;
const YEAR_URL_REGEX = /annual_meeting\/(\d{4})\//;

function extractPaperId(input) {
  if (!input) {
    return null;
  }
  const match = String(input).match(PAPER_ID_REGEX);
  return match ? match[1].toUpperCase() : null;
}

function extractYearFromUrl(url) {
  if (!url) {
    return null;
  }
  const match = String(url).match(YEAR_URL_REGEX);
  return match ? Number(match[1]) : null;
}

function basename(path) {
  if (!path) {
    return '';
  }
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

async function identifyAttachment(attachment, defaultYear) {
  const title = attachment.getField ? attachment.getField('title') : '';
  const url = attachment.getField ? attachment.getField('url') : '';
  let path = '';

  if (typeof attachment.getFilePathAsync === 'function') {
    try {
      path = await attachment.getFilePathAsync() || '';
    } catch (error) {
      path = '';
    }
  }

  const fileName = basename(path) || title;

  return {
    paperId: extractPaperId(fileName) || extractPaperId(title) || extractPaperId(url),
    year: extractYearFromUrl(url) || defaultYear
  };
}

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
    return null;
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
    endMode
  };
}

function normalizeJapaneseAbstract(lines) {
  return lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .join('')
    .replace(/\s+/g, '');
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

async function getFirstPageCandidateFromPdfWorker(attachmentID, debug = null) {
  if (!Zotero.PDFWorker || typeof Zotero.PDFWorker.getFullText !== 'function') {
    if (debug) {
      debug('Zotero.PDFWorker.getFullText is not available');
    }
    return null;
  }

  const attempts = [
    { label: 'getFullText(id, {maxPages:1})', run: () => Zotero.PDFWorker.getFullText(attachmentID, { maxPages: 1 }) },
    { label: 'getFullText(id, 1)', run: () => Zotero.PDFWorker.getFullText(attachmentID, 1) },
    { label: 'getFullText(id)', run: () => Zotero.PDFWorker.getFullText(attachmentID) }
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      const firstPage = pickFirstPagePayload(result);
      if (firstPage) {
        if (debug) {
          const itemCount = Array.isArray(firstPage.items) ? firstPage.items.length : 0;
          debug(
            `PDFWorker success via ${attempt.label}; hasText=${Boolean(firstPage.text)} ` +
            `items=${itemCount} width=${firstPage.width || 'n/a'}`
          );
        }
        return firstPage;
      }
      if (debug) {
        debug(`PDFWorker ${attempt.label} returned payload but first-page parse was empty`);
      }
    } catch (error) {
      if (debug) {
        debug(`PDFWorker ${attempt.label} failed: ${error.message || String(error)}`);
      }
    }
  }

  return null;
}

async function getFirstPageCandidateFromFulltext(attachmentID, debug = null) {
  if (!Zotero.Fulltext || typeof Zotero.Fulltext.getItemText !== 'function') {
    if (debug) {
      debug('Zotero.Fulltext.getItemText is not available');
    }
    return null;
  }

  try {
    const text = await Promise.resolve(Zotero.Fulltext.getItemText(attachmentID));
    const firstPageText = getFirstPageText(text);
    if (!firstPageText) {
      if (debug) {
        debug('Zotero.Fulltext returned empty first-page text');
      }
      return null;
    }
    if (debug) {
      debug(`Zotero.Fulltext first-page text length=${firstPageText.length}`);
    }
    return { text: firstPageText };
  } catch (error) {
    if (debug) {
      debug(`Zotero.Fulltext.getItemText failed: ${error.message || String(error)}`);
    }
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

  const fromPdfWorker = await getFirstPageCandidateFromPdfWorker(attachment.id, debug);
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
      if (debug) {
        debug(
          `PDFWorker positioned left-column lines=${lines.length}; ` +
          `preview="${previewLines(lines)}"`
        );
      }
      const parsed = extractAbstractFromLines(lines, {
        debug,
        source: 'PDFWorker-positioned-left-column'
      });
      if (parsed && parsed.text) {
        return parsed.text;
      }
    }

    if (fromPdfWorker.text) {
      const lines = fromPdfWorker.text.split(/\n+/);
      if (debug) {
        debug(
          `PDFWorker text lines=${lines.length}; preview="${previewLines(lines)}"`
        );
      }
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
  const fromFulltext = await getFirstPageCandidateFromFulltext(attachment.id, debug);
  if (!fromFulltext || !fromFulltext.text) {
    if (debug) {
      debug('no first-page candidate from any source; extraction failed');
    }
    return null;
  }
  const lines = fromFulltext.text.split(/\n+/);
  if (debug) {
    debug(`Zotero.Fulltext lines=${lines.length}; preview="${previewLines(lines)}"`);
  }
  const parsed = extractAbstractFromLines(lines, {
    debug,
    source: 'Zotero.Fulltext-first-page'
  });
  if (!parsed && debug) {
    debug('failed to detect abstract in Zotero.Fulltext output');
  }
  return parsed ? parsed.text : null;
}

function toCreator(name) {
  if (!name) {
    return null;
  }
  const cleaned = String(name).trim();
  if (!cleaned) {
    return null;
  }

  const parts = cleaned.split(/\s+/);
  const hasLatin = /[A-Za-z]/.test(cleaned);
  const hasCJK = /[\u3040-\u30ff\u3400-\u9fff]/.test(cleaned);

  if (parts.length >= 2) {
    if (hasLatin && !hasCJK) {
      return {
        firstName: parts.slice(0, -1).join(' '),
        lastName: parts[parts.length - 1],
        creatorType: 'author'
      };
    }
    return {
      firstName: parts.slice(1).join(' '),
      lastName: parts[0],
      creatorType: 'author'
    };
  }

  return {
    firstName: '',
    lastName: cleaned,
    creatorType: 'author'
  };
}

function buildExtra(paper) {
  const lines = [`ANLP ID: ${paper.paperId}`];
  if (paper.rawAuthors) {
    lines.push(`Authors and Affiliations: ${paper.rawAuthors}`);
  }
  return lines.join('\n');
}

function refreshItemUI(itemID) {
  if (!itemID) {
    return;
  }

  try {
    if (Zotero.Notifier && typeof Zotero.Notifier.trigger === 'function') {
      Zotero.Notifier.trigger('modify', 'item', [itemID], {});
    }
  } catch (error) {
    // Best-effort UI refresh only.
  }

  try {
    if (!Zotero.getActiveZoteroPane) {
      return;
    }
    const pane = Zotero.getActiveZoteroPane();
    if (
      pane &&
      pane.itemsView &&
      typeof pane.itemsView.refreshAndMaintainSelection === 'function'
    ) {
      pane.itemsView.refreshAndMaintainSelection();
    }
  } catch (error) {
    // Best-effort UI refresh only.
  }
}

function shouldUpdateField(parent, field, value, overwriteMode) {
  if (!value) {
    return false;
  }
  if (overwriteMode === 'overwrite') {
    return true;
  }
  return !parent.getField(field);
}

function shouldForceReplaceTitle(existingTitle) {
  return looksLikeAuthorList(String(existingTitle || ''));
}

function shouldForceReplaceProceedings(existingTitle) {
  return /(Top|本会議|チュートリアル|書誌情報|ワークショップ)/.test(
    String(existingTitle || '')
  );
}

function shouldForceReplacePlace(existingPlace) {
  return /(Top|本会議|チュートリアル|書誌情報|ワークショップ)/.test(
    String(existingPlace || '')
  );
}

async function createParent(attachment, paper, conference) {
  const parent = new Zotero.Item('conferencePaper');
  parent.libraryID = attachment.libraryID;

  parent.setField('title', paper.title || paper.paperId);
  parent.setField('date', String(paper.year));
  parent.setField('conferenceName', conference.conferenceName);
  parent.setField('proceedingsTitle', conference.proceedingsTitle);
  parent.setField('publisher', conference.publisher || '言語処理学会');
  if (conference.place) {
    parent.setField('place', conference.place);
  }
  parent.setField('url', paper.pdfUrl);
  parent.setField('extra', buildExtra(paper));
  if (paper.abstractNote) {
    parent.setField('abstractNote', paper.abstractNote);
  }

  const creators = (paper.authors || []).map(toCreator).filter(Boolean);
  if (creators.length) {
    parent.setCreators(creators);
  }

  await parent.saveTx();
  refreshItemUI(parent.id);
  attachment.parentID = parent.id;
  await attachment.saveTx();
  return parent;
}

async function upsertParent(attachment, paper, conference, overwriteMode) {
  let parent = null;
  if (attachment.parentID) {
    parent = await Zotero.Items.getAsync(attachment.parentID);
  }

  if (!parent) {
    await createParent(attachment, paper, conference);
    return;
  }

  if (shouldUpdateField(parent, 'title', paper.title, overwriteMode) ||
    shouldForceReplaceTitle(parent.getField('title'))) {
    parent.setField('title', paper.title || paper.paperId);
  }
  if (shouldUpdateField(parent, 'date', String(paper.year), overwriteMode)) {
    parent.setField('date', String(paper.year));
  }
  if (shouldUpdateField(parent, 'conferenceName', conference.conferenceName, overwriteMode)) {
    parent.setField('conferenceName', conference.conferenceName);
  }
  parent.setField('conferenceName', '');
  if (shouldUpdateField(parent, 'proceedingsTitle', conference.proceedingsTitle, overwriteMode) ||
    shouldForceReplaceProceedings(parent.getField('proceedingsTitle'))) {
    parent.setField('proceedingsTitle', conference.proceedingsTitle);
  }
  if (shouldUpdateField(parent, 'publisher', conference.publisher, overwriteMode)) {
    parent.setField('publisher', conference.publisher || '言語処理学会');
  }
  if (shouldUpdateField(parent, 'place', conference.place, overwriteMode) ||
    shouldForceReplacePlace(parent.getField('place'))) {
    parent.setField('place', conference.place);
  }
  if (shouldUpdateField(parent, 'url', paper.pdfUrl, overwriteMode)) {
    parent.setField('url', paper.pdfUrl);
  }
  if (shouldUpdateField(parent, 'abstractNote', paper.abstractNote, overwriteMode)) {
    parent.setField('abstractNote', paper.abstractNote);
  }

  if (overwriteMode === 'overwrite' || !parent.getField('extra')) {
    parent.setField('extra', buildExtra(paper));
  }

  if (paper.authors && paper.authors.length > 0) {
    const existingCreators = parent.getCreators();
    if (overwriteMode === 'overwrite' || existingCreators.length === 0) {
      parent.setCreators(paper.authors.map(toCreator).filter(Boolean));
    }
  }

  await parent.saveTx();
  refreshItemUI(parent.id);
}

function isPdfAttachment(item) {
  if (!item || typeof item.isAttachment !== 'function' || !item.isAttachment()) {
    return false;
  }
  const cType = String(item.attachmentContentType || '').toLowerCase();
  if (cType === 'application/pdf') {
    return true;
  }
  const title = item.getField ? item.getField('title') : '';
  return /\.pdf$/i.test(title);
}

function getSelectedItems() {
  if (!Zotero.getActiveZoteroPane) {
    return [];
  }
  const pane = Zotero.getActiveZoteroPane();
  if (!pane || !pane.getSelectedItems) {
    return [];
  }
  return pane.getSelectedItems() || [];
}

async function toPdfAttachments(selectedItems) {
  const attachments = [];
  const seen = new Set();

  for (const item of selectedItems || []) {
    if (!item) {
      continue;
    }

    if (isPdfAttachment(item)) {
      if (!seen.has(item.id)) {
        attachments.push(item);
        seen.add(item.id);
      }
      continue;
    }

    if (typeof item.isAttachment === 'function' && item.isAttachment()) {
      continue;
    }

    if (typeof item.getAttachments !== 'function') {
      continue;
    }

    const childIDs = item.getAttachments() || [];
    if (!childIDs.length) {
      continue;
    }

    let children = [];
    if (Zotero.Items && typeof Zotero.Items.getAsync === 'function') {
      children = await Zotero.Items.getAsync(childIDs);
    } else if (Zotero.Items && typeof Zotero.Items.get === 'function') {
      children = Zotero.Items.get(childIDs) || [];
    }

    for (const child of children) {
      if (!isPdfAttachment(child) || seen.has(child.id)) {
        continue;
      }
      attachments.push(child);
      seen.add(child.id);
    }
  }

  return attachments;
}

async function enrichAttachments(attachments) {
  const defaultYear = getDefaultYear();
  const overwriteMode = getOverwriteMode();
  const extractAbstract = getExtractAbstract();

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const attachment of attachments) {
    try {
      const identified = await identifyAttachment(attachment, defaultYear);
      if (!identified.paperId || !identified.year) {
        skipped += 1;
        continue;
      }

      const data = await getYearData(identified.year);
      const paper = data.papers.find((x) => x.paperId === identified.paperId);
      if (!paper) {
        skipped += 1;
        continue;
      }

      const debug = (message) => {
        const title = attachment.getField ? attachment.getField('title') : '';
        log(
          `[abstract] item=${attachment.id || 'unknown'} ` +
          `paperId=${identified.paperId || 'unknown'} ` +
          `title="${String(title || '').slice(0, 120)}" ${message}`
        );
      };

      if (!extractAbstract) {
        debug('skipped extraction because extensions.zotanlp.extractAbstract=false');
      }
      const abstractNote = extractAbstract
        ? await extractAbstractForAttachment(attachment, { debug })
        : '';
      if (extractAbstract) {
        debug(`final abstract result: ${abstractNote ? `chars=${abstractNote.length}` : 'empty'}`);
      }
      await upsertParent(
        attachment,
        { ...paper, abstractNote: abstractNote || '' },
        data.conference,
        overwriteMode
      );
      updated += 1;
    } catch (error) {
      errors += 1;
      log('Enrich failed for attachment', error);
    }
  }

  return { updated, skipped, errors };
}

async function enrichSelected() {
  const selected = getSelectedItems();
  const attachments = await toPdfAttachments(selected);
  return enrichAttachments(attachments);
}

async function onEnrichSelected() {
  try {
    const result = await enrichSelected();
    notify(`Updated: ${result.updated}, skipped: ${result.skipped}, errors: ${result.errors}`);
  } catch (error) {
    log('Manual enrich command failed', error);
    notify(`Failed: ${error.message || String(error)}`);
  }
}

function getMainWindow() {
  return Zotero.getMainWindow ? Zotero.getMainWindow() : null;
}

function findMenuPopup(doc, ids, selector) {
  for (const id of ids) {
    const node = doc.getElementById(id);
    if (node) {
      return node;
    }
  }
  return selector ? doc.querySelector(selector) : null;
}

function buildMenuItem(doc, id) {
  const item = doc.createXULElement
    ? doc.createXULElement('menuitem')
    : doc.createElement('menuitem');
  item.setAttribute('id', id);
  item.setAttribute('label', MENU_LABEL);
  item.addEventListener('command', onEnrichSelected);
  return item;
}

function registerMenuItems() {
  const win = getMainWindow();
  if (!win || !win.document) {
    return false;
  }

  const doc = win.document;
  let registeredAny = false;

  const toolsMenuPopup = findMenuPopup(
    doc,
    ['menu_ToolsPopup', 'menuToolsPopup'],
    'menupopup[id*="Tools"]'
  );
  if (toolsMenuPopup) {
    const existingTools = doc.getElementById('zotanlp-enrich-selected-tools');
    toolsMenuItem = existingTools || buildMenuItem(doc, 'zotanlp-enrich-selected-tools');
    if (!existingTools) {
      toolsMenuPopup.appendChild(toolsMenuItem);
    }
    registeredAny = true;
  }

  const contextMenuPopup = findMenuPopup(
    doc,
    ['zotero-itemmenu', 'zotero-itemmenu-popup', 'zotero-items-tree-context-menu'],
    'menupopup[id*="itemmenu"], menupopup[id*="context"]'
  );
  if (contextMenuPopup) {
    const existingContext = doc.getElementById('zotanlp-enrich-selected-context');
    contextMenuItem = existingContext || buildMenuItem(doc, 'zotanlp-enrich-selected-context');
    if (!existingContext) {
      contextMenuPopup.appendChild(contextMenuItem);
    }
    registeredAny = true;
  }

  return registeredAny;
}

function scheduleMenuRetry() {
  if (menuRetryTimer || menuRetryCount >= MAX_MENU_RETRIES) {
    return;
  }

  menuRetryTimer = setTimeout(() => {
    menuRetryTimer = null;
    menuRetryCount += 1;

    if (!registerMenuItems()) {
      scheduleMenuRetry();
      return;
    }
    menuRetryCount = 0;
  }, 500);
}

function unregisterMenus() {
  if (menuRetryTimer) {
    clearTimeout(menuRetryTimer);
    menuRetryTimer = null;
  }
  menuRetryCount = 0;

  if (toolsMenuItem && toolsMenuItem.parentNode) {
    toolsMenuItem.parentNode.removeChild(toolsMenuItem);
  }
  if (contextMenuItem && contextMenuItem.parentNode) {
    contextMenuItem.parentNode.removeChild(contextMenuItem);
  }
  toolsMenuItem = null;
  contextMenuItem = null;
}

const itemObserver = {
  async notify(event, type, ids) {
    if (type !== 'item' || !getAutoEnrich()) {
      return;
    }
    if (event !== 'add' && event !== 'modify') {
      return;
    }

    for (const id of ids || []) {
      pendingAutoItemIDs.add(id);
    }
    if (autoEnrichTimer) {
      return;
    }

    autoEnrichTimer = setTimeout(async () => {
      autoEnrichTimer = null;
      const toProcess = Array.from(pendingAutoItemIDs);
      pendingAutoItemIDs.clear();

      try {
        const items = await Zotero.Items.getAsync(toProcess);
        const attachments = items.filter(isPdfAttachment);
        if (!attachments.length) {
          return;
        }
        await enrichAttachments(attachments);
      } catch (error) {
        log('Auto enrich failed', error);
      }
    }, 1200);
  }
};

function registerNotifier() {
  if (!Zotero.Notifier) {
    return;
  }
  notifierID = Zotero.Notifier.registerObserver(itemObserver, ['item'], 'zotanlp');
}

function normalizeRootURI(data) {
  if (!data) {
    return '';
  }
  if (typeof data.rootURI === 'string') {
    return data.rootURI;
  }
  if (data.rootURI && typeof data.rootURI.spec === 'string') {
    return data.rootURI.spec;
  }
  if (data.resourceURI && typeof data.resourceURI.spec === 'string') {
    return data.resourceURI.spec;
  }
  return '';
}

function registerPrefsPane() {
  if (
    !addonRootURI ||
    !Zotero.PreferencePanes ||
    typeof Zotero.PreferencePanes.register !== 'function'
  ) {
    return;
  }

  try {
    Zotero.PreferencePanes.register({
      pluginID: PREFS_PANE_PLUGIN_ID,
      src: `${addonRootURI}prefs.xhtml`,
      label: PLUGIN_TITLE,
      defaultXUL: true
    });
    prefsPaneRegistered = true;
  } catch (error) {
    log('Failed to register preferences pane', error);
  }
}

function unregisterPrefsPane() {
  if (
    !prefsPaneRegistered ||
    !Zotero.PreferencePanes ||
    typeof Zotero.PreferencePanes.unregister !== 'function'
  ) {
    return;
  }

  try {
    Zotero.PreferencePanes.unregister(PREFS_PANE_PLUGIN_ID);
  } catch (error) {
    try {
      Zotero.PreferencePanes.unregister({ pluginID: PREFS_PANE_PLUGIN_ID });
    } catch (error2) {
      log('Failed to unregister preferences pane', error2);
    }
  }
  prefsPaneRegistered = false;
}

function unregisterNotifier() {
  if (autoEnrichTimer) {
    clearTimeout(autoEnrichTimer);
    autoEnrichTimer = null;
  }
  pendingAutoItemIDs.clear();
  if (notifierID && Zotero.Notifier) {
    Zotero.Notifier.unregisterObserver(notifierID);
  }
  notifierID = null;
}

function install() {}
function uninstall() {}

function startup(data) {
  migrateAndInitializePrefs();
  addonRootURI = normalizeRootURI(data);
  if (!registerMenuItems()) {
    scheduleMenuRetry();
  }
  registerNotifier();
  registerPrefsPane();
}

function shutdown() {
  unregisterMenus();
  unregisterNotifier();
  unregisterPrefsPane();
}
