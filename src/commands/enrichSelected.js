const { identifyAttachment } = require('../services/matcher');
const { getYearData } = require('../services/anlpClient');
const { ensureParentConferencePaper } = require('../services/zoteroMapper');
const { getDefaultYear, getOverwriteMode } = require('../prefs');

function isPdfAttachment(item) {
  if (!item || typeof item.isAttachment !== 'function' || !item.isAttachment()) {
    return false;
  }

  const cType = item.attachmentContentType || '';
  if (cType.toLowerCase() === 'application/pdf') {
    return true;
  }

  const title = item.getField ? item.getField('title') : '';
  return /\.pdf$/i.test(title);
}

function getSelectedItems() {
  if (typeof Zotero === 'undefined' || !Zotero.getActiveZoteroPane) {
    return [];
  }

  const pane = Zotero.getActiveZoteroPane();
  if (!pane || typeof pane.getSelectedItems !== 'function') {
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
      if (!identified.paperId) {
        skipped += 1;
        continue;
      }

      if (!identified.year) {
        skipped += 1;
        continue;
      }

      const data = await getYearData(identified.year);
      const paper = data.papers.find((item) => item.paperId === identified.paperId);
      if (!paper) {
        skipped += 1;
        continue;
      }

      await ensureParentConferencePaper(
        attachment,
        paper,
        data.conference,
        overwriteMode
      );

      updated += 1;
    } catch (error) {
      errors += 1;
      if (typeof Zotero !== 'undefined' && Zotero.logError) {
        Zotero.logError(error);
      }
    }
  }

  return { updated, skipped, errors, totalSelected: attachments.length };
}

async function enrichSelected() {
  const selected = getSelectedItems();
  const attachments = selected.filter(isPdfAttachment);
  return enrichAttachments(attachments);
}

module.exports = {
  enrichSelected,
  enrichAttachments,
  isPdfAttachment,
  getSelectedItems
};
