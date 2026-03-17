const lexicon = require('../data/japaneseNameLexicon.json');

const JAPANESE_NAME_REGEX = /^[々〆〇ヶぁ-ゖァ-ヺー一-龯]+$/;
const LENGTH_PRIOR = {
  3: [[2, 1], [1, 2]],
  4: [[2, 2], [1, 3], [3, 1]],
  5: [[2, 3], [3, 2], [1, 4], [4, 1]],
  6: [[3, 3], [2, 4], [4, 2], [1, 5], [5, 1]],
  7: [[3, 4], [4, 3], [2, 5], [5, 2], [1, 6], [6, 1]]
};

const surnameSet = new Set(Array.isArray(lexicon.surnames) ? lexicon.surnames : []);
const givenNameSet = new Set(Array.isArray(lexicon.givenNames) ? lexicon.givenNames : []);

function isJapaneseNoSpaceName(name) {
  if (!name) {
    return false;
  }
  const text = String(name).trim();
  if (!text || /\s/.test(text)) {
    return false;
  }
  return JAPANESE_NAME_REGEX.test(text);
}

function getLengthPriorityScore(totalLength, familyLength, givenLength) {
  const pairs = LENGTH_PRIOR[totalLength] || [];
  const idx = pairs.findIndex((pair) => pair[0] === familyLength && pair[1] === givenLength);
  if (idx >= 0) {
    return pairs.length - idx;
  }

  const balanced = -Math.abs(familyLength - givenLength);
  const familyBias = familyLength >= 2 && familyLength <= 3 ? 0.25 : 0;
  return balanced + familyBias;
}

function splitWithDictionaryMatch(name, localSurnameSet, localGivenNameSet) {
  const candidates = [];
  for (let i = 1; i < name.length; i += 1) {
    const family = name.slice(0, i);
    const given = name.slice(i);
    if (!localSurnameSet.has(family) || !localGivenNameSet.has(given)) {
      continue;
    }
    candidates.push({
      family,
      given,
      score: getLengthPriorityScore(name.length, family.length, given.length)
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => (
    b.score - a.score ||
    Math.abs(a.family.length - a.given.length) - Math.abs(b.family.length - b.given.length) ||
    b.family.length - a.family.length
  ));

  return {
    lastName: candidates[0].family,
    firstName: candidates[0].given,
    method: 'dictionary_pair'
  };
}

function splitWithGreedySurname(name, localSurnameSet) {
  for (let i = name.length - 1; i >= 1; i -= 1) {
    const family = name.slice(0, i);
    const given = name.slice(i);
    if (!localSurnameSet.has(family)) {
      continue;
    }
    return {
      lastName: family,
      firstName: given,
      method: 'greedy_surname'
    };
  }

  return null;
}

function splitJapaneseName(name) {
  return splitJapaneseNameWithLexicon(name, surnameSet, givenNameSet);
}

function splitJapaneseNameWithLexicon(name, localSurnameSet, localGivenNameSet) {
  if (!isJapaneseNoSpaceName(name)) {
    return null;
  }

  const text = String(name).trim();
  if (text.length <= 1) {
    return null;
  }

  const dictionaryMatch = splitWithDictionaryMatch(text, localSurnameSet, localGivenNameSet);
  if (dictionaryMatch) {
    return dictionaryMatch;
  }

  const greedyMatch = splitWithGreedySurname(text, localSurnameSet);
  if (greedyMatch) {
    return greedyMatch;
  }

  return null;
}

module.exports = {
  splitJapaneseName,
  splitJapaneseNameWithLexicon,
  isJapaneseNoSpaceName
};
