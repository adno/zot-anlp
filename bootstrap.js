'use strict';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'zotanlp-year-cache-v8.json';
const PREF_PREFIX = 'extensions.zotanlp.';
const LEGACY_PREF_PREFIX = 'extensions.zot-anlp-metadata.';
const PLUGIN_TITLE = 'ZotANLP';
const MENU_LABEL = 'ZotANLP: Add Metadata from Web';
const PREFS_PANE_PLUGIN_ID = 'zot-anlp-metadata@local';

let toolsMenuItem = null;
let contextMenuItem = null;
let toolsMenuPopupNode = null;
let contextMenuPopupNode = null;
let notifierID = null;
let menuRetryTimer = null;
let menuRetryCount = 0;
let menuStateToken = 0;
let autoEnrichTimer = null;
const pendingAutoItemIDs = new Set();
const autoEnrichingAttachmentIDs = new Set();
let loadedFromDisk = false;
let addonRootURI = '';
let prefsPaneRegistered = false;

const MAX_MENU_RETRIES = 20;
const cacheByYear = new Map();
const JAPANESE_NAME_REGEX = /^[々〆〇ヶぁ-ゖァ-ヺー一-龯]+$/;
const NAME_LENGTH_PRIOR = {
  3: [[2, 1], [1, 2]],
  4: [[2, 2], [1, 3], [3, 1]],
  5: [[2, 3], [3, 2], [1, 4], [4, 1]],
  6: [[3, 3], [2, 4], [4, 2], [1, 5], [5, 1]],
  7: [[3, 4], [4, 3], [2, 5], [5, 2], [1, 6], [6, 1]]
};
const jpSurnameSet = new Set();
const jpGivenNameSet = new Set();
let jpNameLexiconLoaded = false;
let jpNameLexiconLoadPromise = null;

function log(message, error) {
  const prefix = '[zot-anlp-metadata]';
  if (typeof Zotero !== 'undefined' && Zotero.debug) {
    Zotero.debug(`${prefix} ${message}`);
    if (error && Zotero.logError) {
      Zotero.logError(error);
    }
  }
}

function debugValue(value, maxLen = 120) {
  const str = value === undefined ? '<undefined>' : String(value === null ? '<null>' : value);
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
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
    overwriteMode: 'missing',
    extractAbstract: true,
    splitNoSpaceUsingEnamdict: true
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

function getOverwriteMode() {
  const normalizeMode = (value) => {
    if (value === 'overwrite' || value === true || value === 1) {
      return 'overwrite';
    }
    const text = String(value || '').trim().toLowerCase();
    if (text === 'overwrite' || text === 'true' || text === '1' || text === 'yes' || text === 'on') {
      return 'overwrite';
    }
    if (text === 'missing' || text === 'false' || text === '0' || text === 'no' || text === 'off') {
      return 'missing';
    }
    return null;
  };

  const current = Zotero.Prefs.get(`${PREF_PREFIX}overwriteMode`, true);
  const currentMode = normalizeMode(current);
  if (currentMode) {
    log(
      `[prefs] overwriteMode resolved from current key: raw=${debugValue(current)} ` +
      `normalized=${currentMode}`
    );
    return currentMode;
  }

  const legacy = Zotero.Prefs.get(`${LEGACY_PREF_PREFIX}overwriteMode`, true);
  const legacyMode = normalizeMode(legacy);
  if (legacyMode) {
    log(
      `[prefs] overwriteMode resolved from legacy key: raw=${debugValue(legacy)} ` +
      `normalized=${legacyMode}`
    );
    return legacyMode;
  }

  log(
    `[prefs] overwriteMode fallback to missing; currentRaw=${debugValue(current)} ` +
    `legacyRaw=${debugValue(legacy)}`
  );
  return 'missing';
}

function getAutoEnrich() {
  return Boolean(getPref('autoEnrich', true));
}

function getExtractAbstract() {
  return Boolean(getPref('extractAbstract', true));
}

function getSplitNoSpaceUsingEnamdict() {
  return Boolean(getPref('splitNoSpaceUsingEnamdict', true));
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

async function clearYearCache() {
  await loadDiskCache();
  const before = cacheByYear.size;
  cacheByYear.clear();
  loadedFromDisk = true;

  const cachePath = getCachePath();
  if (cachePath && typeof IOUtils !== 'undefined') {
    try {
      if (typeof IOUtils.remove === 'function') {
        await IOUtils.remove(cachePath, { ignoreAbsent: true });
      }
    } catch (error) {
      log(`Failed to remove cache file at ${cachePath}`, error);
    }
  }

  log(`[cache] cleared cache entries=${before} path=${cachePath || 'n/a'}`);
  notify(`Cache cleared (${before} year${before === 1 ? '' : 's'}).`);
}

function confirmAndClearYearCache() {
  const prompt = getPromptService();
  if (prompt && typeof prompt.confirmEx === 'function') {
    const choice = prompt.confirmEx(
      null,
      PLUGIN_TITLE,
      'Delete cached ANLP year data now?',
      prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_CANCEL +
        prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING,
      null,
      'Clear Cache',
      null,
      null,
      {}
    );
    if (choice !== 1) {
      return;
    }
  }

  void clearYearCache();
}

function registerPublicApi() {
  if (typeof Zotero === 'undefined') {
    return;
  }
  if (!Zotero.ZotANLP || typeof Zotero.ZotANLP !== 'object') {
    Zotero.ZotANLP = {};
  }
  Zotero.ZotANLP.clearCacheFromPrefs = confirmAndClearYearCache;
}

function unregisterPublicApi() {
  if (typeof Zotero === 'undefined' || !Zotero.ZotANLP) {
    return;
  }
  try {
    delete Zotero.ZotANLP.clearCacheFromPrefs;
    if (Object.keys(Zotero.ZotANLP).length === 0) {
      delete Zotero.ZotANLP;
    }
  } catch (error) {
    // Best effort cleanup.
  }
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
      .replace(/^(?:\s*[○〇◊\*])+/, '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
}

function stripPageRangeNote(text) {
  return String(text || '')
    .replace(/[（(]\s*pp?\.\s*\d+\s*[-–—~〜]\s*\d+\s*[)）]/ig, ' ')
    .replace(/[（(]\s*pp?\.\s*\d+\s*[)）]/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  return stripPageRangeNote(title)
    .replace(/\bPDF\b/gi, '')
    .replace(/\(\s*pdf\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || paperId;
}

function looksLikeAuthorList(text) {
  if (!text) {
    return false;
  }
  const compact = stripPageRangeNote(text).replace(/\s+/g, ' ').trim();
  if (!compact) {
    return false;
  }
  if (/[○〇◊]/.test(compact)) {
    return true;
  }
  if (/（[^）]+）|\([^)]{2,}\)/.test(compact)) {
    return true;
  }
  const delimCount = (compact.match(/[、,，;；・]/g) || []).length;
  return delimCount >= 2 && !/[：:]/.test(compact);
}

function cleanCandidateText(text, paperId) {
  return stripPageRangeNote(String(text || '')
    .replace(new RegExp(`\\b${paperId}\\b`, 'ig'), ' ')
    .replace(/\b(pdf|download)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim());
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
  return stripPageRangeNote(String(line || '')
    .replace(/^Image\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim());
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
  const re = /<a[^>]*href=["']([^"']*pdf_dir\/([A-Z]{1,2}\d{1,2}-\d{1,2})\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titleById = new Map();

  const titleRe = /<span[^>]*id=["']([A-Z]{1,2}\d{1,2}-\d{1,2})[^"']*["'][^>]*>[\s\S]*?<\/span>[\s\S]*?<span[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
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
    const anchorText = normalizeTitle(stripTags(match[3] || ''), paperId);

    const contextHtml = extractContext(html, match.index);
    const parsed = parseAuthorsAndTitleFromContext(contextHtml, paperId);
    const rawAuthors = parsed.rawAuthors || extractRawAuthorsFromContext(contextHtml);
    const authors = rawAuthors ? splitAuthors(rawAuthors) : parsed.authors;
    const title = titleById.get(paperId) ||
      (anchorText && anchorText !== paperId ? anchorText : '') ||
      parsed.title;

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

function decodeHtmlBytes(bytes, contentType = '') {
  if (!(bytes instanceof Uint8Array)) {
    return '';
  }

  const asciiHead = bytesToAscii(bytes);
  const charset = extractCharsetFromHtmlMeta(asciiHead) ||
    extractCharsetFromContentType(contentType) ||
    'utf-8';

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (error) {
    // Fallbacks for environments that do not support the preferred label.
  }

  const fallbacks = ['utf-8', 'shift_jis', 'euc-jp', 'iso-2022-jp', 'windows-1252'];
  for (const candidate of fallbacks) {
    if (candidate === charset) {
      continue;
    }
    try {
      return new TextDecoder(candidate).decode(bytes);
    } catch (error) {
      // Try next fallback.
    }
  }

  return new TextDecoder().decode(bytes);
}

function isLegacyAnnualMeetingUrl(url) {
  const match = String(url || '').match(/annual_meeting\/(\d{4})\//);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  return Number.isFinite(year) && year <= 2005;
}

function hasReplacementChar(text) {
  return /�/.test(String(text || ''));
}

function extractTitlePreview(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return debugValue(match ? stripTags(match[1]) : '', 90);
}

function logEncodingResult(context) {
  const {
    url,
    source,
    contentType,
    declaredCharset,
    bytes,
    text
  } = context;
  const shouldLog = isLegacyAnnualMeetingUrl(url) || hasReplacementChar(text);
  if (!shouldLog) {
    return;
  }

  log(
    `[encoding] source=${source} url=${url} contentType="${debugValue(contentType)}" ` +
      `declaredCharset=${declaredCharset || 'unknown'} bytes=${bytes || 'n/a'} ` +
      `hasReplacement=${hasReplacementChar(text)} titlePreview="${extractTitlePreview(text)}"`
  );
}

async function fetchText(url) {
  if (typeof fetch === 'function') {
    try {
      const fetchResponse = await fetch(url);
      if (!fetchResponse.ok) {
        throw new Error(`HTTP ${fetchResponse.status}`);
      }
      const bytes = new Uint8Array(await fetchResponse.arrayBuffer());
      const contentType = fetchResponse.headers.get('content-type') || '';
      const declaredCharset = extractCharsetFromHtmlMeta(bytesToAscii(bytes)) ||
        extractCharsetFromContentType(contentType) ||
        'utf-8';
      const decoded = decodeHtmlBytes(bytes, contentType);
      logEncodingResult({
        url,
        source: 'fetch-arraybuffer',
        contentType,
        declaredCharset,
        bytes: bytes.length,
        text: decoded
      });
      return decoded;
    } catch (error) {
      log(`Fetch API failed for ${url}; falling back to Zotero.HTTP.request`, error);
    }
  }

  const response = await Zotero.HTTP.request('GET', url, { responseType: 'arraybuffer' });
  const buffer = response ? response.response : null;
  if (buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer)) {
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const contentType = typeof response.getResponseHeader === 'function'
      ? (response.getResponseHeader('Content-Type') || '')
      : '';
    const declaredCharset = extractCharsetFromHtmlMeta(bytesToAscii(bytes)) ||
      extractCharsetFromContentType(contentType) ||
      'utf-8';
    const decoded = decodeHtmlBytes(bytes, contentType);
    logEncodingResult({
      url,
      source: 'zotero-http-arraybuffer',
      contentType,
      declaredCharset,
      bytes: bytes.length,
      text: decoded
    });
    return decoded;
  }

  if (typeof Blob !== 'undefined' && buffer instanceof Blob) {
    const bytes = new Uint8Array(await buffer.arrayBuffer());
    const contentType = typeof response.getResponseHeader === 'function'
      ? (response.getResponseHeader('Content-Type') || '')
      : '';
    const declaredCharset = extractCharsetFromHtmlMeta(bytesToAscii(bytes)) ||
      extractCharsetFromContentType(contentType) ||
      'utf-8';
    const decoded = decodeHtmlBytes(bytes, contentType);
    logEncodingResult({
      url,
      source: 'zotero-http-blob',
      contentType,
      declaredCharset,
      bytes: bytes.length,
      text: decoded
    });
    return decoded;
  }

  if (typeof response.response === 'string') {
    const text = response.response;
    logEncodingResult({
      url,
      source: 'zotero-http-string',
      contentType: '',
      declaredCharset: '',
      bytes: null,
      text
    });
    if (isLegacyAnnualMeetingUrl(url) && hasReplacementChar(text)) {
      try {
        const docResponse = await Zotero.HTTP.request('GET', url, { responseType: 'document' });
        const doc = docResponse ? docResponse.response : null;
        const docHtml = doc && doc.documentElement ? doc.documentElement.outerHTML : '';
        if (docHtml) {
          logEncodingResult({
            url,
            source: 'zotero-http-document-fallback',
            contentType: '',
            declaredCharset: doc.characterSet || '',
            bytes: null,
            text: docHtml
          });
          return docHtml;
        }
      } catch (error) {
        log(`Document fallback failed for ${url}`, error);
      }
    }
    return text;
  }
  const textResponse = await Zotero.HTTP.request('GET', url);
  if (typeof textResponse.response === 'string') {
    const text = textResponse.response;
    logEncodingResult({
      url,
      source: 'zotero-http-text-response',
      contentType: '',
      declaredCharset: '',
      bytes: null,
      text
    });
    return text;
  }
  try {
    if (typeof textResponse.responseText === 'string') {
      const text = textResponse.responseText;
      logEncodingResult({
        url,
        source: 'zotero-http-responseText',
        contentType: '',
        declaredCharset: '',
        bytes: null,
        text
      });
      return text;
    }
  } catch (error) {
    // Ignore invalid responseText getter access and fall through.
  }
  return '';
}

function isFrameDocument(html) {
  return /<(?:frameset|frame)\b/i.test(String(html || ''));
}

function extractFrameTargets(html, baseUrl) {
  const tags = String(html || '').match(/<frame\b[^>]*>/gi) || [];
  const targets = [];

  for (const tag of tags) {
    const srcMatch = tag.match(/\bsrc\s*=\s*["']?([^"'>\s]+)/i);
    if (!srcMatch || !srcMatch[1]) {
      continue;
    }

    const nameMatch = tag.match(/\bname\s*=\s*["']?([^"'>\s]+)/i);
    let href = '';
    try {
      href = new URL(srcMatch[1], baseUrl).href;
    } catch (error) {
      href = '';
    }
    if (!href) {
      continue;
    }

    const name = (nameMatch && nameMatch[1]) ? String(nameMatch[1]).toLowerCase() : '';
    const score = (
      (/\bbody|main|content\b/.test(name) ? 4 : 0) +
      (/\bprogram\b/i.test(srcMatch[1]) ? 3 : 0)
    );
    targets.push({ href, score });
  }

  return targets
    .sort((a, b) => b.score - a.score)
    .map((target) => target.href)
    .filter((href, index, arr) => arr.indexOf(href) === index);
}

async function resolveProgramHtml(year) {
  const rootUrl = `https://www.anlp.jp/proceedings/annual_meeting/${year}/`;
  const rootHtml = await fetchText(rootUrl);
  if (parseProgramHtml(rootHtml, year).length > 0 || !isFrameDocument(rootHtml)) {
    return rootHtml;
  }

  const frameTargets = extractFrameTargets(rootHtml, rootUrl);
  for (const targetUrl of frameTargets) {
    const targetHtml = await fetchText(targetUrl);
    if (parseProgramHtml(targetHtml, year).length > 0) {
      return targetHtml;
    }
  }

  return rootHtml;
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

  const biblioURL = `https://www.anlp.jp/proceedings/annual_meeting/${year}/html/biblio.html`;

  const programHtml = await resolveProgramHtml(year);
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

function shouldRetryWithFreshYearData(paper) {
  if (!paper) {
    return true;
  }

  const title = String(paper.title || '').trim();
  const rawAuthors = String(paper.rawAuthors || '').trim();
  if (!title || title === String(paper.paperId || '').trim()) {
    return true;
  }

  if (hasReplacementChar(title) || hasReplacementChar(rawAuthors)) {
    return true;
  }

  // Old cached parser output sometimes leaked page ranges into author metadata.
  if (/\bpp?\.\s*\d+\s*[-–—~〜]\s*\d+/i.test(rawAuthors)) {
    return true;
  }

  // If raw authors exists but does not look like an author line, treat cache as stale.
  if (rawAuthors && !looksLikeAuthorList(rawAuthors)) {
    return true;
  }

  return false;
}

const PAPER_ID_REGEX = /([A-Z]{1,2}\d{1,2}-\d{1,2})/i;
const STRICT_PAPER_FILENAME_REGEX = /^([A-Z]{1,2}\d{1,2}-\d{1,2})\.pdf$/i;
const YEAR_URL_REGEX = /annual_meeting\/(\d{4})\//;
const ANLP_HEADER_YEAR_REGEX = /言語処理学会.*(\d{4})\s*年/u;

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

function normalizePaperId(id) {
  return id ? String(id).toUpperCase() : null;
}

function getAttachmentTitle(attachment) {
  return attachment && attachment.getField ? String(attachment.getField('title') || '') : '';
}

function getAttachmentUrl(attachment) {
  return attachment && attachment.getField ? String(attachment.getField('url') || '').trim() : '';
}

function getAttachmentDisplayName(meta) {
  return meta.fileName || meta.title || `Item ${meta.itemID || 'unknown'}`;
}

function getAttachmentFileNameQuick(attachment) {
  if (!attachment) {
    return '';
  }

  if (typeof attachment.getFilename === 'function') {
    try {
      const name = attachment.getFilename();
      if (name) {
        return String(name);
      }
    } catch (error) {
      // Ignore and continue fallback.
    }
  }

  if (typeof attachment.getFilePath === 'function') {
    try {
      const path = attachment.getFilePath();
      if (path) {
        return basename(path);
      }
    } catch (error) {
      // Ignore and continue fallback.
    }
  }

  return getAttachmentTitle(attachment);
}

function isAnlpUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'anlp.jp' || host === 'www.anlp.jp';
  } catch (error) {
    return false;
  }
}

async function getAttachmentMeta(attachment) {
  const title = getAttachmentTitle(attachment);
  const url = getAttachmentUrl(attachment);
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
    itemID: attachment ? attachment.id : null,
    title,
    url,
    path,
    fileName,
    displayName: getAttachmentDisplayName({
      itemID: attachment ? attachment.id : null,
      title,
      fileName
    })
  };
}

function buildAttachmentIssue(meta, reasonCode, reason, extra = {}) {
  return {
    attachment: meta.attachment || null,
    itemID: meta.itemID,
    displayName: meta.displayName,
    fileName: meta.fileName,
    title: meta.title,
    url: meta.url,
    reasonCode,
    reason,
    ...extra
  };
}

async function identifyAttachmentForEnrich(attachment) {
  const meta = await getAttachmentMeta(attachment);
  meta.attachment = attachment;

  const loosePaperId = normalizePaperId(
    extractPaperId(meta.fileName) || extractPaperId(meta.title) || extractPaperId(meta.url)
  );

  if (meta.url) {
    if (!isAnlpUrl(meta.url)) {
      return buildAttachmentIssue(
        meta,
        'url_not_anlp_domain',
        'URL is present but not on anlp.jp'
      );
    }
    if (!loosePaperId) {
      return buildAttachmentIssue(
        meta,
        'url_missing_paper_id',
        'ANLP paper ID was not found in URL/title/file name'
      );
    }

    const year = extractYearFromUrl(meta.url);
    if (!year) {
      return buildAttachmentIssue(
        meta,
        'url_missing_year',
        'URL does not include annual_meeting/<year>/'
      );
    }

    return {
      ...meta,
      paperId: loosePaperId,
      year,
      source: 'url',
      eligible: true
    };
  }

  const strictMatch = String(meta.fileName || '').match(STRICT_PAPER_FILENAME_REGEX);
  if (!strictMatch) {
    return buildAttachmentIssue(
      meta,
      'strict_filename_required_no_url',
      'No URL: file name must be exactly like B1-12.pdf'
    );
  }

  const paperId = normalizePaperId(strictMatch[1]);
  const header = await extractConferenceYearFromAttachment(attachment);
  if (!header.hasConferenceMarker || !header.year) {
    return buildAttachmentIssue(
      meta,
      'manual_year_required',
      !header.hasConferenceMarker
        ? 'No URL: first page does not contain 言語処理学会'
        : 'No URL: could not infer year from first-page header',
      { paperId, manualYearCandidate: true }
    );
  }

  return {
    ...meta,
    paperId,
    year: header.year,
    source: 'file_header',
    eligible: true
  };
}

function seemsAnlpAttachmentQuick(item) {
  if (!isPdfAttachment(item)) {
    return false;
  }

  const url = getAttachmentUrl(item);
  const fileName = getAttachmentFileNameQuick(item);
  if (url) {
    if (!isAnlpUrl(url)) {
      return false;
    }
    return Boolean(extractPaperId(fileName) || extractPaperId(url) || extractPaperId(getAttachmentTitle(item)));
  }

  return STRICT_PAPER_FILENAME_REGEX.test(fileName);
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

function getPageTexts(fullText) {
  const normalized = String(fullText || '').replace(/\r/g, '');
  if (!normalized) {
    return [];
  }
  return normalized.split(/\f/);
}

function extractProceedingsPageNumberFromLines(inputLines) {
  const lines = (inputLines || [])
    .map((line) => String(line || '').replace(/\r/g, '').trim())
    .filter(Boolean);
  const bottomLines = lines.slice(-12).reverse();

  for (const line of bottomLines) {
    const match = line.match(/(?:^|\s)[—–―-]\s*(\d{1,5})\s*[—–―-](?:\s|$)/u);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function extractProceedingsPagesFromPageTexts(pageTexts) {
  const texts = pageTexts || [];
  const pageNumbers = texts
    .map((text) => extractProceedingsPageNumberFromLines(String(text || '').split(/\n+/)))
    .filter((pageNumber) => Number.isInteger(pageNumber));

  if (pageNumbers.length === 0 || texts.length === 0) {
    return '';
  }

  const last = pageNumbers[pageNumbers.length - 1];
  const expectedFirst = last - texts.length + 1;
  if (expectedFirst < 1) {
    return '';
  }

  for (let i = 1; i < pageNumbers.length; i += 1) {
    if (pageNumbers[i] !== pageNumbers[i - 1] + 1) {
      return '';
    }
  }

  const firstDetected = pageNumbers[0];
  if (firstDetected < expectedFirst || firstDetected > last) {
    return '';
  }

  const first = expectedFirst;
  if (last < first) {
    return '';
  }
  if (first === last) {
    return String(first);
  }
  return `${first}-${last}`;
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

function pickPagePayloads(payload) {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => pickPagePayloads(entry));
  }
  if (typeof payload === 'string') {
    return getPageTexts(payload).map((text) => ({ text }));
  }
  if (Array.isArray(payload.pages)) {
    return payload.pages.flatMap((page) => pickPagePayloads(page));
  }
  if (typeof payload.text === 'string') {
    const pageTexts = getPageTexts(payload.text);
    const items = payload.items || payload.tokens || payload.chars || null;
    return pageTexts.map((text) => ({
      text,
      items: pageTexts.length === 1 ? items : null,
      width: payload.width || payload.pageWidth || null
    }));
  }
  if (Array.isArray(payload.items) || Array.isArray(payload.tokens) || Array.isArray(payload.chars)) {
    return [{
      text: '',
      items: payload.items || payload.tokens || payload.chars,
      width: payload.width || payload.pageWidth || null
    }];
  }
  return [];
}

function pagePayloadToText(page) {
  if (!page) {
    return '';
  }
  if (Array.isArray(page.items) && page.items.length > 0) {
    return extractLinesFromPositionedItems(page.items, null).join('\n');
  }
  return String(page.text || '');
}

async function getFullPageTextsFromPdfWorker(attachmentID, debug = null) {
  if (!Zotero.PDFWorker || typeof Zotero.PDFWorker.getFullText !== 'function') {
    return [];
  }

  try {
    const result = await Zotero.PDFWorker.getFullText(attachmentID);
    const pageTexts = pickPagePayloads(result).map(pagePayloadToText).filter(Boolean);
    if (debug) {
      debug(`PDFWorker proceedings pages candidates=${pageTexts.length}`);
    }
    return pageTexts;
  } catch (error) {
    if (debug) {
      debug(`PDFWorker proceedings page extraction failed: ${error.message || String(error)}`);
    }
    return [];
  }
}

async function getFullPageTextsFromFulltext(attachmentID, debug = null) {
  if (!Zotero.Fulltext || typeof Zotero.Fulltext.getItemText !== 'function') {
    return [];
  }

  try {
    const text = await Promise.resolve(Zotero.Fulltext.getItemText(attachmentID));
    const pageTexts = getPageTexts(text).filter(Boolean);
    if (debug) {
      debug(`Zotero.Fulltext proceedings pages candidates=${pageTexts.length}`);
    }
    return pageTexts;
  } catch (error) {
    if (debug) {
      debug(`Zotero.Fulltext proceedings page extraction failed: ${error.message || String(error)}`);
    }
    return [];
  }
}

async function extractProceedingsPagesForAttachment(attachment, options = {}) {
  const debug = typeof options.debug === 'function' ? options.debug : null;
  if (!attachment || !attachment.id) {
    return '';
  }

  const fromPdfWorker = await getFullPageTextsFromPdfWorker(attachment.id, debug);
  const fromPdfWorkerPages = extractProceedingsPagesFromPageTexts(fromPdfWorker);
  if (fromPdfWorkerPages) {
    return fromPdfWorkerPages;
  }

  const fromFulltext = await getFullPageTextsFromFulltext(attachment.id, debug);
  return extractProceedingsPagesFromPageTexts(fromFulltext);
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

async function getFirstPageLinesForAttachment(attachment, debug = null) {
  if (!attachment || !attachment.id) {
    return [];
  }

  const fromPdfWorker = await getFirstPageCandidateFromPdfWorker(attachment.id, debug);
  if (fromPdfWorker) {
    if (Array.isArray(fromPdfWorker.items) && fromPdfWorker.items.length > 0) {
      const lines = extractLinesFromPositionedItems(fromPdfWorker.items, fromPdfWorker.width);
      if (lines.length > 0) {
        return lines;
      }
    }
    if (fromPdfWorker.text) {
      const lines = fromPdfWorker.text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (lines.length > 0) {
        return lines;
      }
    }
  }

  const fromFulltext = await getFirstPageCandidateFromFulltext(attachment.id, debug);
  if (!fromFulltext || !fromFulltext.text) {
    return [];
  }
  return fromFulltext.text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

async function extractConferenceYearFromAttachment(attachment, debug = null) {
  const lines = await getFirstPageLinesForAttachment(attachment, debug);
  const merged = lines.join(' ').replace(/\s+/g, ' ').trim();
  const hasConferenceMarker = merged.includes('言語処理学会');
  const yearMatch = merged.match(ANLP_HEADER_YEAR_REGEX);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  return {
    hasConferenceMarker,
    year: Number.isFinite(year) ? year : null
  };
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

      const fullWidthLines = extractLinesFromPositionedItems(fromPdfWorker.items, null);
      if (debug) {
        debug(
          `PDFWorker positioned full-page lines=${fullWidthLines.length}; ` +
          `preview="${previewLines(fullWidthLines)}"`
        );
      }
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

async function ensureJapaneseNameLexiconLoaded() {
  if (jpNameLexiconLoaded) {
    return;
  }
  if (jpNameLexiconLoadPromise) {
    await jpNameLexiconLoadPromise;
    return;
  }

  jpNameLexiconLoadPromise = (async () => {
    if (!addonRootURI || typeof fetch !== 'function') {
      return;
    }

    try {
      const url = `${addonRootURI}src/data/japaneseNameLexicon.json`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      const surnames = Array.isArray(json.surnames) ? json.surnames : [];
      const givenNames = Array.isArray(json.givenNames) ? json.givenNames : [];

      jpSurnameSet.clear();
      jpGivenNameSet.clear();
      for (const name of surnames) {
        if (JAPANESE_NAME_REGEX.test(String(name))) {
          jpSurnameSet.add(String(name));
        }
      }
      for (const name of givenNames) {
        if (JAPANESE_NAME_REGEX.test(String(name))) {
          jpGivenNameSet.add(String(name));
        }
      }

      jpNameLexiconLoaded = true;
      log(
        `[name] loaded Japanese name lexicon surnames=${jpSurnameSet.size} ` +
          `givenNames=${jpGivenNameSet.size}`
      );
    } catch (error) {
      log('[name] failed to load Japanese name lexicon; using fallback behavior', error);
    }
  })();

  await jpNameLexiconLoadPromise;
}

function getNameLengthPriorityScore(totalLength, familyLength, givenLength) {
  const pairs = NAME_LENGTH_PRIOR[totalLength] || [];
  const idx = pairs.findIndex((pair) => pair[0] === familyLength && pair[1] === givenLength);
  if (idx >= 0) {
    return pairs.length - idx;
  }

  const balanced = -Math.abs(familyLength - givenLength);
  const familyBias = familyLength >= 2 && familyLength <= 3 ? 0.25 : 0;
  return balanced + familyBias;
}

function splitJapaneseName(name) {
  if (!jpNameLexiconLoaded || !JAPANESE_NAME_REGEX.test(name) || name.length <= 1) {
    return null;
  }

  const candidates = [];
  for (let i = 1; i < name.length; i += 1) {
    const family = name.slice(0, i);
    const given = name.slice(i);
    if (!jpSurnameSet.has(family) || !jpGivenNameSet.has(given)) {
      continue;
    }
    candidates.push({
      family,
      given,
      score: getNameLengthPriorityScore(name.length, family.length, given.length)
    });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => (
      b.score - a.score ||
      Math.abs(a.family.length - a.given.length) - Math.abs(b.family.length - b.given.length) ||
      b.family.length - a.family.length
    ));
    return {
      lastName: candidates[0].family,
      firstName: candidates[0].given,
      method: 'dictionary_pair'
    };
  }

  for (let i = name.length - 1; i >= 1; i -= 1) {
    const family = name.slice(0, i);
    const given = name.slice(i);
    if (!jpSurnameSet.has(family)) {
      continue;
    }
    return {
      lastName: family,
      firstName: given,
      method: 'greedy_surname'
    };
  }

  return null;
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

  if (getSplitNoSpaceUsingEnamdict() && JAPANESE_NAME_REGEX.test(cleaned) && cleaned.length > 1) {
    const split = splitJapaneseName(cleaned);
    if (split) {
      return {
        firstName: split.firstName,
        lastName: split.lastName,
        creatorType: 'author'
      };
    }
  }

  return {
    firstName: '',
    lastName: cleaned,
    creatorType: 'author'
  };
}

function inferLanguageFromTitle(title) {
  const text = String(title || '');
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text) ? 'ja' : 'en';
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

function getItemTypeID(itemType) {
  if (
    typeof Zotero !== 'undefined' &&
    Zotero.ItemTypes &&
    typeof Zotero.ItemTypes.getID === 'function'
  ) {
    return Zotero.ItemTypes.getID(itemType);
  }
  return itemType;
}

function getItemTypeName(item) {
  if (!item) {
    return '';
  }
  if (typeof item.getType === 'function') {
    return item.getType();
  }
  if (typeof item.getItemType === 'function') {
    return item.getItemType();
  }
  if (item.itemType) {
    return item.itemType;
  }
  if (
    typeof Zotero !== 'undefined' &&
    Zotero.ItemTypes &&
    typeof Zotero.ItemTypes.getName === 'function' &&
    item.itemTypeID
  ) {
    return Zotero.ItemTypes.getName(item.itemTypeID);
  }
  return '';
}

function ensureItemType(item, itemType) {
  if (getItemTypeName(item) === itemType) {
    return;
  }

  const itemTypeID = getItemTypeID(itemType);
  if (typeof item.setType === 'function') {
    item.setType(itemTypeID);
    return;
  }

  if ('itemTypeID' in item) {
    item.itemTypeID = itemTypeID;
  }
  if ('itemType' in item) {
    item.itemType = itemType;
  }
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
  const title = paper.title || paper.paperId;

  parent.setField('title', title);
  parent.setField('language', inferLanguageFromTitle(title));
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
  if (paper.pages) {
    parent.setField('pages', paper.pages);
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

async function upsertParent(
  attachment,
  paper,
  conference,
  overwriteMode,
  createParentIfMissing = true
) {
  let parent = null;
  if (attachment.parentID) {
    parent = await Zotero.Items.getAsync(attachment.parentID);
  }

  if (!parent) {
    if (!createParentIfMissing) {
      log(
        `[upsert] item=${attachment.id || 'unknown'} skipped parent creation ` +
        'during auto-enrich'
      );
      return false;
    }
    await createParent(attachment, paper, conference);
    return true;
  }

  ensureItemType(parent, 'conferencePaper');

  const existingTitle = parent.getField('title');
  const incomingTitle = paper.title || paper.paperId;
  const incomingLanguage = inferLanguageFromTitle(incomingTitle);
  const shouldUpdateTitle = shouldUpdateField(parent, 'title', paper.title, overwriteMode);
  const forceReplaceTitle = shouldForceReplaceTitle(existingTitle);
  log(
    `[upsert] item=${parent.id || 'unknown'} paperId=${paper.paperId || 'unknown'} ` +
    `mode=${overwriteMode} title existing="${debugValue(existingTitle)}" ` +
    `incoming="${debugValue(incomingTitle)}" ` +
    `shouldUpdate=${shouldUpdateTitle} forceReplace=${forceReplaceTitle}`
  );
  if (shouldUpdateTitle || forceReplaceTitle) {
    parent.setField('title', incomingTitle);
  }
  if (
    shouldUpdateField(parent, 'language', incomingLanguage, overwriteMode) ||
    shouldUpdateTitle ||
    forceReplaceTitle
  ) {
    parent.setField('language', incomingLanguage);
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
  if (shouldUpdateField(parent, 'pages', paper.pages, overwriteMode)) {
    parent.setField('pages', paper.pages);
  }

  const existingExtra = parent.getField('extra');
  const shouldUpdateExtra = overwriteMode === 'overwrite' || !existingExtra;
  log(
    `[upsert] item=${parent.id || 'unknown'} extra existing="${debugValue(existingExtra)}" ` +
    `incoming="${debugValue(buildExtra(paper))}" shouldUpdate=${shouldUpdateExtra}`
  );
  if (shouldUpdateExtra) {
    parent.setField('extra', buildExtra(paper));
  }

  if (paper.authors && paper.authors.length > 0) {
    const existingCreators = parent.getCreators();
    const shouldUpdateCreators = overwriteMode === 'overwrite' || existingCreators.length === 0;
    log(
      `[upsert] item=${parent.id || 'unknown'} creators existingCount=${existingCreators.length} ` +
      `incomingCount=${paper.authors.length} shouldUpdate=${shouldUpdateCreators}`
    );
    if (shouldUpdateCreators) {
      parent.setCreators(paper.authors.map(toCreator).filter(Boolean));
    }
  }

  await parent.saveTx();
  refreshItemUI(parent.id);
  return true;
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

async function enrichAttachments(attachments, options = {}) {
  const overwriteMode = getOverwriteMode();
  const extractAbstract = getExtractAbstract();
  const createParentIfMissing = options.createParentIfMissing !== false;
  await ensureJapaneseNameLexiconLoaded();
  log(
    `[enrich] start selected=${attachments.length} overwriteMode=${overwriteMode} ` +
    `extractAbstract=${extractAbstract}`
  );

  const result = {
    updated: 0,
    skipped: 0,
    errors: 0,
    totalSelected: attachments.length,
    problems: []
  };
  const pendingManualYear = [];

  async function processIdentifiedAttachment(identified) {
    try {
      const attachment = identified.attachment;
      let data = await getYearData(identified.year);
      let paper = data.papers.find((x) => x.paperId === identified.paperId);
      let retried = false;
      if (!paper || shouldRetryWithFreshYearData(paper)) {
        retried = true;
        log(
          `[enrich] refreshing year=${identified.year} for paperId=${identified.paperId} ` +
          `reason=${paper ? 'suspicious_cached_metadata' : 'paper_not_found'}`
        );
        data = await getYearData(identified.year, true);
        paper = data.papers.find((x) => x.paperId === identified.paperId);
      }
      if (!paper) {
        result.skipped += 1;
        result.problems.push(buildAttachmentIssue(
          identified,
          'paper_not_found',
          `No ANLP entry found for ${identified.paperId} in year ${identified.year}`
        ));
        return;
      }

      const debug = (message) => {
        const title = attachment.getField ? attachment.getField('title') : '';
        log(
          `[abstract] item=${attachment.id || 'unknown'} ` +
          `paperId=${identified.paperId || 'unknown'} ` +
          `title="${String(title || '').slice(0, 120)}" ${message}`
        );
      };
      if (retried) {
        log(
          `[enrich] refreshed paper metadata paperId=${paper.paperId} ` +
          `title="${debugValue(paper.title)}" rawAuthors="${debugValue(paper.rawAuthors)}" ` +
          `authorsCount=${Array.isArray(paper.authors) ? paper.authors.length : 0}`
        );
      }

      if (!extractAbstract) {
        debug('skipped extraction because extensions.zotanlp.extractAbstract=false');
      }
      const abstractNote = extractAbstract
        ? await extractAbstractForAttachment(attachment, { debug })
        : '';
      if (extractAbstract) {
        debug(`final abstract result: ${abstractNote ? `chars=${abstractNote.length}` : 'empty'}`);
      }
      const pages = await extractProceedingsPagesForAttachment(attachment, { debug });
      if (pages) {
        debug(`proceedings pages extracted: ${pages}`);
      }

      const changed = await upsertParent(
        attachment,
        { ...paper, abstractNote: abstractNote || '', pages },
        data.conference,
        overwriteMode,
        createParentIfMissing
      );
      if (changed) {
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.errors += 1;
      result.problems.push(buildAttachmentIssue(
        identified,
        'processing_error',
        `Processing failed: ${error.message || String(error)}`
      ));
      log('Enrich failed for attachment', error);
    }
  }

  for (const attachment of attachments) {
    try {
      const identified = await identifyAttachmentForEnrich(attachment);
      if (identified.eligible) {
        await processIdentifiedAttachment(identified);
        continue;
      }

      if (identified.manualYearCandidate) {
        pendingManualYear.push(identified);
        continue;
      }

      result.skipped += 1;
      result.problems.push(identified);
    } catch (error) {
      result.errors += 1;
      const meta = await getAttachmentMeta(attachment).catch(() => ({
        itemID: attachment ? attachment.id : null,
        displayName: `Item ${attachment && attachment.id ? attachment.id : 'unknown'}`,
        fileName: '',
        title: '',
        url: ''
      }));
      result.problems.push(buildAttachmentIssue(
        meta,
        'identification_error',
        `Identification failed: ${error.message || String(error)}`
      ));
      log('Identify failed for attachment', error);
    }
  }

  if (pendingManualYear.length > 0) {
    const manualYear = promptManualYearForUnresolved(pendingManualYear);
    if (!manualYear) {
      for (const item of pendingManualYear) {
        result.skipped += 1;
        result.problems.push(buildAttachmentIssue(
          item,
          'manual_year_cancelled',
          'User canceled manual year search'
        ));
      }
    } else {
      for (const item of pendingManualYear) {
        await processIdentifiedAttachment({
          ...item,
          year: manualYear,
          source: 'manual_year',
          eligible: true
        });
      }
    }
  }

  return result;
}

async function enrichSelected() {
  const selected = getSelectedItems();
  const attachments = await toPdfAttachments(selected);
  return enrichAttachments(attachments);
}

function getPromptService() {
  if (typeof Services !== 'undefined' && Services.prompt) {
    return Services.prompt;
  }
  return null;
}

function promptManualYearForUnresolved(items) {
  const prompt = getPromptService();
  if (!prompt || typeof prompt.confirmEx !== 'function' || typeof prompt.prompt !== 'function') {
    return null;
  }

  const names = items.map((item) => `- ${item.displayName}`).join('\n');
  const choice = prompt.confirmEx(
    null,
    PLUGIN_TITLE,
    `Could not determine conference/year for the following files:\n\n${names}\n\n` +
      'Choose "Search in a Year" to retry all of them with one year.',
    prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_CANCEL +
      prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING,
    null,
    'Search in a Year',
    null,
    null,
    {}
  );

  if (choice !== 1) {
    return null;
  }

  while (true) {
    const input = { value: String(new Date().getFullYear()) };
    const accepted = prompt.prompt(
      null,
      PLUGIN_TITLE,
      'Enter year for manual metadata search (example: 2026):',
      input,
      null,
      {}
    );
    if (!accepted) {
      return null;
    }

    const year = Number(String(input.value || '').trim());
    if (Number.isFinite(year) && year >= 2000 && year <= 2100) {
      return year;
    }
    notify('Invalid year. Enter a 4-digit year between 2000 and 2100, or Cancel.');
  }
}

function formatEnrichResultMessage(result) {
  const lines = [];
  lines.push(`Updated: ${result.updated}`);
  lines.push(`Skipped: ${result.skipped}`);
  lines.push(`Errors: ${result.errors}`);
  lines.push(`Selected PDFs: ${result.totalSelected}`);

  if (result.problems && result.problems.length > 0) {
    lines.push('');
    lines.push('Problematic files:');
    for (const problem of result.problems) {
      lines.push(`- ${problem.displayName}: ${problem.reason}`);
    }
  }

  return lines.join('\n');
}

async function onEnrichSelected() {
  try {
    const result = await enrichSelected();
    notify(formatEnrichResultMessage(result));
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

function setMenuItemsEnabled(enabled) {
  const disabled = !enabled;
  for (const item of [toolsMenuItem, contextMenuItem]) {
    if (!item) {
      continue;
    }
    if (disabled) {
      item.setAttribute('disabled', 'true');
    } else {
      item.removeAttribute('disabled');
    }
  }
}

async function updateMenuEnabledState() {
  const token = ++menuStateToken;
  setMenuItemsEnabled(false);
  try {
    const selected = getSelectedItems();
    const attachments = await toPdfAttachments(selected);
    const enabled = attachments.some((attachment) => seemsAnlpAttachmentQuick(attachment));
    if (token !== menuStateToken) {
      return;
    }
    setMenuItemsEnabled(enabled);
  } catch (error) {
    log('Failed to update menu state', error);
    if (token !== menuStateToken) {
      return;
    }
    setMenuItemsEnabled(false);
  }
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
    toolsMenuPopupNode = toolsMenuPopup;
    const existingTools = doc.getElementById('zotanlp-enrich-selected-tools');
    toolsMenuItem = existingTools || buildMenuItem(doc, 'zotanlp-enrich-selected-tools');
    if (!existingTools) {
      toolsMenuPopup.appendChild(toolsMenuItem);
    }
    toolsMenuPopup.removeEventListener('popupshowing', updateMenuEnabledState);
    toolsMenuPopup.addEventListener('popupshowing', updateMenuEnabledState);
    registeredAny = true;
  }

  const contextMenuPopup = findMenuPopup(
    doc,
    ['zotero-itemmenu', 'zotero-itemmenu-popup', 'zotero-items-tree-context-menu'],
    'menupopup[id*="itemmenu"], menupopup[id*="context"]'
  );
  if (contextMenuPopup) {
    contextMenuPopupNode = contextMenuPopup;
    const existingContext = doc.getElementById('zotanlp-enrich-selected-context');
    contextMenuItem = existingContext || buildMenuItem(doc, 'zotanlp-enrich-selected-context');
    if (!existingContext) {
      contextMenuPopup.appendChild(contextMenuItem);
    }
    contextMenuPopup.removeEventListener('popupshowing', updateMenuEnabledState);
    contextMenuPopup.addEventListener('popupshowing', updateMenuEnabledState);
    registeredAny = true;
  }

  if (registeredAny) {
    void updateMenuEnabledState();
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

  if (toolsMenuPopupNode) {
    toolsMenuPopupNode.removeEventListener('popupshowing', updateMenuEnabledState);
    toolsMenuPopupNode = null;
  }
  if (contextMenuPopupNode) {
    contextMenuPopupNode.removeEventListener('popupshowing', updateMenuEnabledState);
    contextMenuPopupNode = null;
  }

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
        const attachments = items.filter((item) => (
          isPdfAttachment(item) &&
          item.parentID &&
          !autoEnrichingAttachmentIDs.has(item.id)
        ));
        if (!attachments.length) {
          return;
        }
        for (const attachment of attachments) {
          autoEnrichingAttachmentIDs.add(attachment.id);
        }
        try {
          await enrichAttachments(attachments, { createParentIfMissing: false });
        } finally {
          for (const attachment of attachments) {
            autoEnrichingAttachmentIDs.delete(attachment.id);
          }
        }
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
  autoEnrichingAttachmentIDs.clear();
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
  registerPublicApi();
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
  unregisterPublicApi();
}
