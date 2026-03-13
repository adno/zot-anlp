const { parseProgramHtml, parseBiblioHtml } = require('./anlpParser');
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
  return response.text();
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
    fetchText(programUrl(year)),
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
