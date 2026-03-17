const DEFAULTS = {
  overwriteMode: 'missing',
  autoEnrich: true,
  extractAbstract: true,
  splitNoSpaceUsingEnamdict: true
};

function getPref(key, fallback) {
  if (typeof Zotero === 'undefined' || !Zotero.Prefs) {
    return fallback;
  }

  const prefName = `extensions.zot-anlp-metadata.${key}`;
  const value = Zotero.Prefs.get(prefName, true);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function getOverwriteMode() {
  const normalizeMode = (value) => {
    if (value === 'overwrite' || value === true || value === 1) {
      return 'overwrite';
    }
    const text = String(value || '').trim().toLowerCase();
    if (text === 'overwrite' || text === 'true' || text === '1' || text === 'yes' || text === 'on') {
      return 'overwrite';
    }
    if (text === 'missing' || text === 'false' || text === '0' || text === 'no' || text === 'off') {
      return 'missing';
    }
    return null;
  };

  const current = getPref('overwriteMode', DEFAULTS.overwriteMode);
  const currentMode = normalizeMode(current);
  if (currentMode) {
    return currentMode;
  }

  // Legacy namespace fallback for safety.
  if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
    const legacy = Zotero.Prefs.get('extensions.zot-anlp-metadata.overwriteMode', true);
    const legacyMode = normalizeMode(legacy);
    if (legacyMode) {
      return legacyMode;
    }
  }

  return 'missing';
}

function getAutoEnrich() {
  return Boolean(getPref('autoEnrich', DEFAULTS.autoEnrich));
}

function getExtractAbstract() {
  return Boolean(getPref('extractAbstract', DEFAULTS.extractAbstract));
}

function getSplitNoSpaceUsingEnamdict() {
  return Boolean(getPref('splitNoSpaceUsingEnamdict', DEFAULTS.splitNoSpaceUsingEnamdict));
}

module.exports = {
  getOverwriteMode,
  getAutoEnrich,
  getExtractAbstract,
  getSplitNoSpaceUsingEnamdict,
  DEFAULTS
};
