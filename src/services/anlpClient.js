const { parseProgramHtml, parseBiblioHtml } = require('./anlpParser');
const { decodeHtmlBytes } = require('./htmlEncoding');
const { getYearIndex, setYearIndex } = require('./indexStore');

function programUrl(year) {
  return `https://www.anlp.jp/proceedings/annual_meeting/${year}/`;
}

function biblioUrl(year) {
  return `https://www.anlp.jp/proceedings/annual_meeting/${year}/html/biblio.html`;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return decodeHtmlBytes(bytes, response.headers.get('content-type') || '');
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
  const rootUrl = programUrl(year);
  const rootHtml = await fetchText(rootUrl);
  if (parseProgramHtml(rootHtml, year).length > 0 || !isFrameDocument(rootHtml)) {
    return rootHtml;
  }

  const firstLevelTargets = extractFrameTargets(rootHtml, rootUrl);
  for (const targetUrl of firstLevelTargets) {
    const targetHtml = await fetchText(targetUrl);
    if (parseProgramHtml(targetHtml, year).length > 0) {
      return targetHtml;
    }
  }

  return rootHtml;
}

async function getYearData(year, options = {}) {
  const { forceRefresh = false } = options;
  if (!forceRefresh) {
    const cached = await getYearIndex(year);
    if (cached) {
      return cached;
    }
  }

  const [programHtml, biblioHtml] = await Promise.all([
    resolveProgramHtml(year),
    fetchText(biblioUrl(year)).catch(() => '')
  ]);

  const papers = parseProgramHtml(programHtml, year);
  const conference = parseBiblioHtml(biblioHtml, year);
  const data = { papers, conference };

  await setYearIndex(year, data);
  return data;
}

module.exports = {
  programUrl,
  biblioUrl,
  getYearData
};
