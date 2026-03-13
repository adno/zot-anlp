const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'zot-anlp-year-cache.json';
const byYear = new Map();

let loadedFromDisk = false;

function getCachePath() {
  if (typeof PathUtils === 'undefined' || typeof Zotero === 'undefined') {
    return null;
  }
  if (!Zotero.Profile || !Zotero.Profile.dir) {
    return null;
  }
  return PathUtils.join(Zotero.Profile.dir, CACHE_FILE_NAME);
}

async function loadDiskCache() {
  if (loadedFromDisk) {
    return;
  }
  loadedFromDisk = true;

  const cachePath = getCachePath();
  if (!cachePath || typeof IOUtils === 'undefined') {
    return;
  }

  try {
    const json = await IOUtils.readUTF8(cachePath);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    for (const [year, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      if (!entry.createdAt || !entry.data) {
        continue;
      }
      byYear.set(String(year), {
        createdAt: Number(entry.createdAt),
        data: entry.data
      });
    }
  } catch (error) {
    // Cache file is optional; ignore read/parse failures.
  }
}

async function writeDiskCache() {
  const cachePath = getCachePath();
  if (!cachePath || typeof IOUtils === 'undefined') {
    return;
  }

  const obj = {};
  for (const [year, entry] of byYear.entries()) {
    obj[year] = entry;
  }

  await IOUtils.writeUTF8(cachePath, JSON.stringify(obj));
}

function isExpired(entry) {
  return Date.now() - entry.createdAt > CACHE_TTL_MS;
}

async function getYearIndex(year) {
  await loadDiskCache();

  const key = String(year);
  const entry = byYear.get(key);
  if (!entry) {
    return null;
  }
  if (isExpired(entry)) {
    byYear.delete(key);
    await writeDiskCache().catch(() => {});
    return null;
  }
  return entry.data;
}

async function setYearIndex(year, data) {
  await loadDiskCache();

  byYear.set(String(year), {
    createdAt: Date.now(),
    data
  });

  await writeDiskCache().catch(() => {});
}

async function clearCache() {
  byYear.clear();
  await writeDiskCache().catch(() => {});
}

module.exports = {
  getYearIndex,
  setYearIndex,
  clearCache
};
