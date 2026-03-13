const PAPER_ID_REGEX = /([A-Z]{1,2}\d-\d{1,2})/i;
const YEAR_URL_REGEX = /annual_meeting\/(\d{4})\//;

function normalizePaperId(id) {
  return id ? id.toUpperCase() : null;
}

function extractPaperId(input) {
  if (!input) {
    return null;
  }
  const match = String(input).match(PAPER_ID_REGEX);
  return match ? normalizePaperId(match[1]) : null;
}

function extractYearFromUrl(url) {
  if (!url) {
    return null;
  }
  const match = String(url).match(YEAR_URL_REGEX);
  return match ? Number(match[1]) : null;
}

async function getAttachmentPath(attachment) {
  if (!attachment) {
    return '';
  }

  if (typeof attachment.getFilePathAsync === 'function') {
    const path = await attachment.getFilePathAsync();
    if (path) {
      return path;
    }
  }

  if (typeof attachment.getFilePath === 'function') {
    return attachment.getFilePath() || '';
  }

  return '';
}

function basename(path) {
  if (!path) {
    return '';
  }
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

async function identifyAttachment(attachment, defaultYear = null) {
  const title = attachment.getField ? attachment.getField('title') : '';
  const url = attachment.getField ? attachment.getField('url') : '';
  const path = await getAttachmentPath(attachment);
  const fileName = basename(path) || title;

  const paperId =
    extractPaperId(fileName) ||
    extractPaperId(title) ||
    extractPaperId(url);

  const year = extractYearFromUrl(url) || defaultYear;

  return {
    paperId,
    year,
    fileName,
    url
  };
}

module.exports = {
  extractPaperId,
  extractYearFromUrl,
  identifyAttachment,
  normalizePaperId
};
