const { splitJapaneseName } = require('./japaneseNameSplitter');
const { getSplitNoSpaceUsingEnamdict } = require('../prefs');

function inferLanguageFromTitle(title) {
  const text = String(title || '');
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text) ? 'ja' : 'en';
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

  if (getSplitNoSpaceUsingEnamdict()) {
    const jpSplit = splitJapaneseName(cleaned);
    if (jpSplit) {
      return {
        firstName: jpSplit.firstName,
        lastName: jpSplit.lastName,
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

function refreshItemUI(itemID) {
  if (!itemID || typeof Zotero === 'undefined') {
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

async function createParentItem(attachment, paper, conference) {
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
  parent.setField('extra', `ANLP ID: ${paper.paperId}`);
  if (paper.abstractNote) {
    parent.setField('abstractNote', paper.abstractNote);
  }

  const creators = (paper.authors || []).map(toCreator).filter(Boolean);
  if (creators.length > 0) {
    parent.setCreators(creators);
  }

  await parent.saveTx();
  refreshItemUI(parent.id);
  return parent;
}

function shouldUpdateField(parent, field, value, overwriteMode) {
  if (!value) {
    return false;
  }
  if (overwriteMode === 'overwrite') {
    return true;
  }
  const existing = parent.getField(field);
  return !existing;
}

async function updateParentItem(parent, paper, conference, overwriteMode = 'missing') {
  const title = paper.title || paper.paperId;
  const language = inferLanguageFromTitle(title);

  if (shouldUpdateField(parent, 'title', paper.title, overwriteMode)) {
    parent.setField('title', title);
  }
  if (shouldUpdateField(parent, 'language', language, overwriteMode)) {
    parent.setField('language', language);
  }
  if (shouldUpdateField(parent, 'date', String(paper.year), overwriteMode)) {
    parent.setField('date', String(paper.year));
  }
  if (shouldUpdateField(parent, 'conferenceName', conference.conferenceName, overwriteMode)) {
    parent.setField('conferenceName', conference.conferenceName);
  }
  if (shouldUpdateField(parent, 'proceedingsTitle', conference.proceedingsTitle, overwriteMode)) {
    parent.setField('proceedingsTitle', conference.proceedingsTitle);
  }
  if (shouldUpdateField(parent, 'publisher', conference.publisher, overwriteMode)) {
    parent.setField('publisher', conference.publisher || '言語処理学会');
  }
  if (shouldUpdateField(parent, 'place', conference.place, overwriteMode)) {
    parent.setField('place', conference.place);
  }
  if (shouldUpdateField(parent, 'url', paper.pdfUrl, overwriteMode)) {
    parent.setField('url', paper.pdfUrl);
  }
  if (shouldUpdateField(parent, 'abstractNote', paper.abstractNote, overwriteMode)) {
    parent.setField('abstractNote', paper.abstractNote);
  }

  if (overwriteMode === 'overwrite' || !parent.getField('extra')) {
    parent.setField('extra', `ANLP ID: ${paper.paperId}`);
  }

  if (paper.authors && paper.authors.length > 0) {
    const existingCreators = parent.getCreators();
    if (overwriteMode === 'overwrite' || existingCreators.length === 0) {
      parent.setCreators(paper.authors.map(toCreator).filter(Boolean));
    }
  }

  await parent.saveTx();
  refreshItemUI(parent.id);
  return parent;
}

async function ensureParentConferencePaper(attachment, paper, conference, overwriteMode = 'missing') {
  let parent = null;
  if (attachment.parentID) {
    parent = await Zotero.Items.getAsync(attachment.parentID);
  }

  if (!parent) {
    parent = await createParentItem(attachment, paper, conference);
    attachment.parentID = parent.id;
    await attachment.saveTx();
    return { parent, created: true };
  }

  await updateParentItem(parent, paper, conference, overwriteMode);
  return { parent, created: false };
}

module.exports = {
  ensureParentConferencePaper,
  inferLanguageFromTitle,
  toCreator
};
