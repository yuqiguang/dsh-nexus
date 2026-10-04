import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputDecoder, pythonUtf8Output } from '../src/coders/decode.js';

const GBK = Buffer.from('c8abb2bfcda8b9fd', 'hex');
const decode = (chunks: Buffer[], fallbacks = ['gbk', 'windows-1252']) => {
  const decoder = createOutputDecoder(fallbacks);
  return chunks.map(chunk => decoder.push(chunk)).join('') + decoder.flush();
};

test('GBK and UTF-8 output is identical for every partition of a short byte stream', () => {
  for (const [bytes, expected] of [[GBK, '全部通过'], [Buffer.from('中文'), '中文']] as const) {
    for (let mask = 0; mask < 2 ** (bytes.length - 1); mask++) {
      const chunks: Buffer[] = []; let start = 0;
      for (let i = 1; i < bytes.length; i++) if (mask & (1 << (i - 1))) { chunks.push(bytes.subarray(start, i)); start = i; }
      chunks.push(bytes.subarray(start));
      assert.equal(decode(chunks), expected, `partition ${mask}`);
    }
  }
});

test('after selection the streaming decoder preserves GBK characters across every boundary', () => {
  for (let cut = 0; cut <= GBK.length; cut++) {
    assert.equal(decode([Buffer.concat([GBK, Buffer.from('\n')]), GBK.subarray(0, cut), GBK.subarray(cut)]), '全部通过\n全部通过');
  }
});

test('ASCII progress is immediate, final partial lines flush once, and sampling is bounded', () => {
  const decoder = createOutputDecoder(['gbk']);
  assert.equal(decoder.push(Buffer.from('progress ')), 'progress ');
  assert.equal(decoder.push(GBK), '');
  assert.equal(decoder.flush(), '全部通过');
  assert.equal(decoder.flush(), '');
  const long = '中'.repeat(5000);
  const d = createOutputDecoder();
  const first = d.push(Buffer.from(long));
  assert.ok(first.length > 0);
  assert.equal(first + d.flush(), long);
});

test('single-byte fallback and independent pipes preserve their own text', () => {
  assert.equal(decode([Buffer.from([0x61, 0xe9]), Buffer.from([0x20, 0x62])]), 'aé b');
  const out = createOutputDecoder(), err = createOutputDecoder();
  const bytes = Buffer.from('中');
  let text = out.push(bytes.subarray(0, 1));
  text += err.push(Buffer.from('ERR'));
  text += out.push(bytes.subarray(1));
  text += out.flush() + err.flush();
  assert.equal(text, 'ERR中');
});

test('Python children request UTF-8 output only on Windows', () => {
  assert.deepEqual(pythonUtf8Output('win32'), { PYTHONIOENCODING: 'utf-8' });
  assert.deepEqual(pythonUtf8Output('linux'), {});
});
