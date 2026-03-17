const test = require('node:test');
const assert = require('node:assert/strict');

const { getYearData } = require('../src/services/anlpClient');
const { clearCache } = require('../src/services/indexStore');

function responseFromText(text, contentType = 'text/html; charset=utf-8') {
  const bytes = new TextEncoder().encode(String(text));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'content-type' ? contentType : '';
      }
    },
    async arrayBuffer() {
      return buffer;
    }
  };
}

test('getYearData follows frameset body frame for legacy ANLP pages', async (t) => {
  const oldFetch = global.fetch;
  const calls = [];

  t.after(async () => {
    global.fetch = oldFetch;
    await clearCache();
  });

  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);

    if (u === 'https://www.anlp.jp/proceedings/annual_meeting/2011/') {
      return responseFromText(`
<!DOCTYPE HTML>
<html><frameset cols="150px,*">
  <frame name="menu" src="html/menu.html">
  <frame name="body" src="html/program.html">
</frameset></html>`);
    }

    if (u === 'https://www.anlp.jp/proceedings/annual_meeting/2011/html/program.html') {
      return responseFromText(`
<html><body>
  <div>○山田 太郎、田中 花子：フレーム対応の検証</div>
  <a href="pdf_dir/A1-01.pdf">PDF</a>
</body></html>`);
    }

    if (u === 'https://www.anlp.jp/proceedings/annual_meeting/2011/html/menu.html') {
      return responseFromText('<html><body>menu</body></html>');
    }

    if (u === 'https://www.anlp.jp/proceedings/annual_meeting/2011/html/biblio.html') {
      return {
        ok: false,
        status: 404,
        headers: { get() { return ''; } },
        async arrayBuffer() { return new ArrayBuffer(0); }
      };
    }

    throw new Error(`Unexpected URL: ${u}`);
  };

  const data = await getYearData(2011, { forceRefresh: true });

  assert.equal(data.papers.length, 1);
  assert.equal(data.papers[0].paperId, 'A1-01');
  assert.equal(
    data.papers[0].pdfUrl,
    'https://www.anlp.jp/proceedings/annual_meeting/2011/pdf_dir/A1-01.pdf'
  );
  assert.ok(
    calls.includes('https://www.anlp.jp/proceedings/annual_meeting/2011/html/program.html')
  );
});
