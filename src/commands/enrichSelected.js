const { identifyAttachment } = require('../services/matcher');
const { getYearData } = require('../services/anlpClient');
const { ensureParentConferencePaper } = require('../services/zoteroMapper');
const { extractAbstractForAttachment } = require('../services/abstractExtractor');
const {
  getDefaultYear,
  getOverwriteMode,
  getExtractAbstract
} = require('../prefs');

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
    if (
      typeof Zotero !== 'undefined' &&
      Zotero.Items &&
      typeof Zotero.Items.getAsync === 'function'
    ) {
      children = await Zotero.Items.getAsync(childIDs);
    } else if (
      typeof Zotero !== 'undefined' &&
      Zotero.Items &&
      typeof Zotero.Items.get === 'function'
    ) {
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

      const debug = typeof Zotero !== 'undefined' && typeof Zotero.debug === 'function'
        ? (message) => {
          const title = attachment.getField ? attachment.getField('title') : '';
          Zotero.debug(
            `[zot-anlp-metadata][abstract] item=${attachment.id || 'unknown'} ` +
            `title="${String(title || '').slice(0, 120)}" ${message}`
          );
        }
        : null;

      const abstractText = extractAbstract
        ? await extractAbstractForAttachment(attachment, { debug })
        : '';
      if (debug && !extractAbstract) {
        debug('skipped extraction because extensions.zotanlp.extractAbstract=false');
      }
      await ensureParentConferencePaper(
        attachment,
        { ...paper, abstractNote: abstractText || '' },
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
  const attachments = await toPdfAttachments(selected);
  return enrichAttachments(attachments);
}

module.exports = {
  enrichSelected,
  enrichAttachments,
  isPdfAttachment,
  getSelectedItems,
  toPdfAttachments
};
