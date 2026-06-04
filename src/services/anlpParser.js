function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAuthorToken(token) {
  return token
    .replace(/^(?:\s*[○〇◊\*])+/, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAuthors(text) {
  if (!text) {
    return [];
  }
  return text
    .split(/[、,，;；・]/)
    .map(normalizeAuthorToken)
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

function stripPageRangeNote(text) {
  return String(text || '')
    .replace(/[（(]\s*pp?\.\s*\d+\s*[-–—~〜]\s*\d+\s*[)）]/ig, ' ')
    .replace(/[（(]\s*pp?\.\s*\d+\s*[)）]/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function extractContext(html, index) {
  const start = Math.max(0, index - 5000);
  const end = Math.min(html.length, index + 5000);
  return html.slice(start, end);
}

function parseAuthorsAndTitleFromContext(contextText, paperId) {
  const compact = contextText.replace(/\s+/g, ' ').trim();
  const idRegex = new RegExp(`\\b${paperId}\\b`, 'i');
  const idMatch = compact.match(idRegex);
  const afterId = idMatch
    ? compact.slice((idMatch.index || 0) + paperId.length).trim()
    : compact;

  const cleaned = stripPageRangeNote(afterId)
    .replace(/\b(pdf|download)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const { authors, title } = splitAuthorsAndTitle(`${paperId} ${cleaned}`);
  return {
    authors,
    title: normalizeTitle(title, paperId)
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

  function extractRawAuthorsFromContext(contextHtml, paperId) {
    const rows = String(contextHtml).match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      if (!new RegExp(`pdf_dir/${paperId}\\.pdf`, 'i').test(row)) {
        continue;
      }
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdRe.exec(row)) !== null) {
        cells.push(stripTags(tdMatch[1] || '').replace(/\s+/g, ' ').trim());
      }
      for (const cell of cells) {
        if (/[○〇◊]/.test(cell)) {
          return stripPageRangeNote(cell.split(/[：:]/)[0] || '');
        }
      }
    }
    return '';
  }

  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const paperId = match[2].toUpperCase();
    const anchorText = stripTags(match[3] || '');

    const context = stripTags(extractContext(html, match.index));
    const contextHtml = extractContext(html, match.index);
    const parsed = parseAuthorsAndTitleFromContext(context, paperId);
    const rawAuthors = extractRawAuthorsFromContext(contextHtml, paperId);
    const title = titleById.get(paperId) ||
      (anchorText && !/^pdf$/i.test(anchorText)
        ? normalizeTitle(anchorText, paperId)
        : parsed.title);

    papers.push({
      paperId,
      year,
      title,
      authors: rawAuthors ? splitAuthors(rawAuthors) : parsed.authors,
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
  const fallbackConferenceName =
    `Annual Meeting of the Association for Natural Language Processing (NLP${year})`;

  if (!html) {
    return {
      conferenceName: fallbackConferenceName,
      proceedingsTitle: `言語処理学会第${String(year).slice(2)}回年次大会発表論文集`,
      publisher: '言語処理学会',
      place: ''
    };
  }

  const text = stripTags(html);
  const proceedingsMatch = text.match(/(言語処理学会[^。\n]*年次大会[^。\n]*論文集)/);
  const placeMatch = text.match(/(?:会場|於)[:：]?\s*([^。\n]+)/);

  return {
    conferenceName: fallbackConferenceName,
    proceedingsTitle: proceedingsMatch ? proceedingsMatch[1].trim() : fallbackConferenceName,
    publisher: '言語処理学会',
    place: placeMatch ? placeMatch[1].trim() : ''
  };
}

module.exports = {
  parseProgramHtml,
  parseBiblioHtml,
  splitAuthors,
  splitAuthorsAndTitle,
  normalizeTitle,
  stripTags
};
