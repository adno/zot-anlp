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

async function createParentItem(attachment, paper, conference) {
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
  parent.setField('extra', `ANLP ID: ${paper.paperId}`);

  const creators = (paper.authors || []).map(toCreator).filter(Boolean);
  if (creators.length > 0) {
    parent.setCreators(creators);
  }

  await parent.saveTx();
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
  if (shouldUpdateField(parent, 'title', paper.title, overwriteMode)) {
    parent.setField('title', paper.title || paper.paperId);
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
  toCreator
};
