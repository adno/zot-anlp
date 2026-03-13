'use strict';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'zotanlp-year-cache-v4.json';
const PREF_PREFIX = 'extensions.zot-anlp-metadata.';
const PLUGIN_TITLE = 'ZotANLP';
const MENU_LABEL = 'ZotANLP: Add Metadata From Web';

let toolsMenuItem = null;
let contextMenuItem = null;
let notifierID = null;
let menuRetryTimer = null;
let menuRetryCount = 0;
let autoEnrichTimer = null;
const pendingAutoItemIDs = new Set();
let loadedFromDisk = false;

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
  const value = Zotero.Prefs.get(prefName, true);
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value;
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

function toCreator(name) {
  if (!name) {
    return null;
  }
  const cleaned = String(name).trim();
  if (!cleaned) {
    return null;
  }

  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) {
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

  const creators = (paper.authors || []).map(toCreator).filter(Boolean);
  if (creators.length) {
    parent.setCreators(creators);
  }

  await parent.saveTx();
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

async function enrichAttachments(attachments) {
  const defaultYear = getDefaultYear();
  const overwriteMode = getOverwriteMode();

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

      await upsertParent(attachment, paper, data.conference, overwriteMode);
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
  const attachments = selected.filter(isPdfAttachment);
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

function startup() {
  if (!registerMenuItems()) {
    scheduleMenuRetry();
  }
  registerNotifier();
}

function shutdown() {
  unregisterMenus();
  unregisterNotifier();
}
