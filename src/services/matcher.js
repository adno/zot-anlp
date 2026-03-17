const PAPER_ID_REGEX = /([A-Z]{1,2}\d{1,2}-\d{1,2})/i;
const STRICT_PAPER_FILENAME_REGEX = /^([A-Z]{1,2}\d{1,2}-\d{1,2})\.pdf$/i;
const YEAR_URL_REGEX = /annual_meeting\/(\d{4})\//;

function normalizePaperId(id) {
  return id ? id.toUpperCase() : null;
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

async function identifyAttachment(attachment) {
  const title = attachment.getField ? attachment.getField('title') : '';
  const url = attachment.getField ? String(attachment.getField('url') || '').trim() : '';
  const path = await getAttachmentPath(attachment);
  const fileName = basename(path) || title;

  let paperId = null;
  let year = null;
  let reasonCode = '';

  if (url) {
    if (!isAnlpUrl(url)) {
      reasonCode = 'url_not_anlp_domain';
    } else {
      paperId = extractPaperId(fileName) || extractPaperId(title) || extractPaperId(url);
      if (!paperId) {
        reasonCode = 'url_missing_paper_id';
      } else {
        year = extractYearFromUrl(url);
        if (!year) {
          reasonCode = 'url_missing_year';
        }
      }
    }
  } else {
    const strictMatch = fileName.match(STRICT_PAPER_FILENAME_REGEX);
    if (!strictMatch) {
      reasonCode = 'strict_filename_required_no_url';
    } else {
      paperId = normalizePaperId(strictMatch[1]);
    }
  }

  return {
    paperId,
    year,
    fileName,
    url,
    reasonCode
  };
}

module.exports = {
  extractPaperId,
  extractYearFromUrl,
  identifyAttachment,
  normalizePaperId,
  isAnlpUrl
};
