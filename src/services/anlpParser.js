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
    .replace(/^[○〇\*]+/, '')
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

function extractContext(html, index) {
  const tagNames = ['tr', 'li', 'p', 'div', 'td'];
  const lower = html.toLowerCase();

  let start = Math.max(0, index - 600);
  let end = Math.min(html.length, index + 900);

  for (const tag of tagNames) {
    const openIdx = lower.lastIndexOf(`<${tag}`, index);
    const closeIdx = lower.indexOf(`</${tag}>`, index);
    if (openIdx >= 0 && closeIdx > index) {
      start = Math.max(0, openIdx);
      end = Math.min(html.length, closeIdx + tag.length + 3);
      break;
    }
  }

  return html.slice(start, end);
}

function parseAuthorsAndTitleFromContext(contextText, paperId) {
  const compact = contextText.replace(/\s+/g, ' ').trim();
  const idRegex = new RegExp(`\\b${paperId}\\b`, 'i');
  const idMatch = compact.match(idRegex);
  const afterId = idMatch
    ? compact.slice((idMatch.index || 0) + paperId.length).trim()
    : compact;

  const cleaned = afterId
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
  const re = /<a[^>]*href=["']([^"']*pdf_dir\/([A-Z]{1,2}\d-\d{1,2})\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const paperId = match[2].toUpperCase();
    const anchorText = stripTags(match[3] || '');

    const context = stripTags(extractContext(html, match.index));
    const parsed = parseAuthorsAndTitleFromContext(context, paperId);
    const title = anchorText && !/^pdf$/i.test(anchorText)
      ? normalizeTitle(anchorText, paperId)
      : parsed.title;

    papers.push({
      paperId,
      year,
      title,
      authors: parsed.authors,
      pdfUrl: href.startsWith('http')
        ? href
        : `https://www.anlp.jp/proceedings/annual_meeting/${year}/${href.replace(/^\/+/, '')}`,
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
