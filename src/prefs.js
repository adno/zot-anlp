const DEFAULTS = {
  defaultYear: new Date().getFullYear(),
  overwriteMode: 'missing',
  autoEnrich: true,
  extractAbstract: true
};

function getPref(key, fallback) {
  if (typeof Zotero === 'undefined' || !Zotero.Prefs) {
    return fallback;
  }

  const prefName = `extensions.zot-anlp-metadata.${key}`;
  const value = Zotero.Prefs.get(prefName, true);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function getDefaultYear() {
  const year = Number(getPref('defaultYear', DEFAULTS.defaultYear));
  return Number.isFinite(year) ? year : DEFAULTS.defaultYear;
}

function getOverwriteMode() {
  const mode = getPref('overwriteMode', DEFAULTS.overwriteMode);
  return mode === 'overwrite' ? 'overwrite' : 'missing';
}

function getAutoEnrich() {
  return Boolean(getPref('autoEnrich', DEFAULTS.autoEnrich));
}

function getExtractAbstract() {
  return Boolean(getPref('extractAbstract', DEFAULTS.extractAbstract));
}

module.exports = {
  getDefaultYear,
  getOverwriteMode,
  getAutoEnrich,
  getExtractAbstract,
  DEFAULTS
};
