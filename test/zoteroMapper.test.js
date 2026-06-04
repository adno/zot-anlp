const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureParentConferencePaper } = require('../src/services/zoteroMapper');

test('existing parent is converted before conference fields are set', async () => {
  const operations = [];
  const fields = {
    title: '',
    language: '',
    date: '',
    conferenceName: '',
    proceedingsTitle: '',
    publisher: '',
    place: '',
    pages: '',
    url: '',
    abstractNote: '',
    extra: ''
  };
  const parent = {
    id: 42,
    itemType: 'journalArticle',
    getType() {
      return this.itemType;
    },
    setType(itemTypeID) {
      operations.push(['setType', itemTypeID]);
      this.itemType = itemTypeID;
    },
    getField(field) {
      operations.push(['getField', field]);
      return fields[field] || '';
    },
    setField(field, value) {
      operations.push(['setField', field]);
      if (field === 'proceedingsTitle' && this.itemType !== 'conferencePaper') {
        throw new Error(
          "'proceedingsTitle' is not a valid field for type 'journalArticle'"
        );
      }
      fields[field] = value;
    },
    getCreators() {
      return [];
    },
    setCreators(creators) {
      operations.push(['setCreators', creators]);
    },
    async saveTx() {
      operations.push(['saveTx']);
    }
  };
  const attachment = {
    parentID: parent.id
  };
  const paper = {
    paperId: 'B1-1',
    title: 'テスト論文',
    year: 2026,
    pdfUrl: 'https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/B1-1.pdf',
    pages: '1914-1916',
    authors: ['山田 太郎']
  };
  const conference = {
    conferenceName: '言語処理学会第32回年次大会',
    proceedingsTitle: '言語処理学会第32回年次大会発表論文集',
    publisher: '言語処理学会',
    place: '大阪'
  };

  global.Zotero = {
    Items: {
      async getAsync(itemID) {
        assert.equal(itemID, parent.id);
        return parent;
      }
    },
    ItemTypes: {
      getID(itemType) {
        return itemType;
      }
    }
  };

  try {
    const result = await ensureParentConferencePaper(
      attachment,
      paper,
      conference,
      'missing'
    );

    assert.equal(result.parent, parent);
    assert.equal(result.created, false);
    assert.equal(fields.proceedingsTitle, conference.proceedingsTitle);
    assert.equal(fields.pages, paper.pages);
    assert.deepEqual(operations[0], ['setType', 'conferencePaper']);
  } finally {
    delete global.Zotero;
  }
});
