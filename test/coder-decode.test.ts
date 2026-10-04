import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputDecoder, pythonUtf8Output } from '../src/coders/decode.js';

/** GBK for 全部通过 — the console code page a Chinese Windows Python writes into a pipe (ct-4c671559). */
const GBK = Buffer.from('c8abb2bfcda8b9fd', 'hex');
const windows = process.platform === 'win32';
const decode = (chunks: Buffer[]) => { const decoder = createOutputDecoder(); return chunks.map(chunk => decoder.push(chunk)).join('') + decoder.flush(); };

test('a stream that is not UTF-8 is read as one code page rather than as replacement characters', () => {
  // Windows tries its own console code page first, so the Chinese above comes back as text; elsewhere the fallback is the
  // Latin-1 superset, which reads the same bytes as letters. Neither path may show a replacement character.
  const text = decode([GBK]);
  assert.equal(text, windows ? '全部通过' : 'È«²¿Í¨¹ý');
  assert.doesNotMatch(text, /�/);
});

test('a chunk boundary never introduces replacement characters, and ASCII is never mangled', () => {
  for (const cuts of [[1], [2], [3], [1, 2], [2, 4], [1, 3, 5, 7]]) {
    const chunks: Buffer[] = [Buffer.from('ok ')];
    let at = 0;
    for (const cut of cuts) { chunks.push(GBK.subarray(at, cut)); at = cut; }
    chunks.push(GBK.subarray(at));
    const text = decode(chunks);
    assert.doesNotMatch(text, /�/, `chunked at ${cuts.join(',')}`);
    assert.ok(text.startsWith('ok '), `chunked at ${cuts.join(',')}`);
  }
});

test('the code page is decided once and then holds for the rest of the stream', () => {
  // Each boundary here leaves a first chunk that is not valid UTF-8 — the ordinary case — so the reading cannot change.
  for (const cut of [1, 3, 4, 5, 6]) assert.equal(decode([GBK.subarray(0, cut), GBK.subarray(cut)]), decode([GBK]), `boundary after byte ${cut}`);
  // A first chunk that is itself valid UTF-8 is read as UTF-8 and the bytes after it cannot undo that: 0xc8 0xab is also the
  // (otherwise unlikely) character `ȫ`. Guessing loses only on a prefix like this, which is why the strict pass is tried first.
  assert.notEqual(decode([GBK.subarray(0, 2), GBK.subarray(2)]), decode([GBK]));
});

test('clean UTF-8 passes through unchanged, including a character split across chunks', () => {
  const utf8 = Buffer.from('全部通过', 'utf8');
  assert.equal(decode([utf8]), '全部通过');
  for (let cut = 1; cut < utf8.length; cut++) assert.equal(decode([utf8.subarray(0, cut), utf8.subarray(cut)]), '全部通过', `cut at ${cut}`);
});

test('a single-byte code page is decided from the bytes that can be read, not held back', () => {
  // 0xe9 before a space is `é` in windows-1252 and an invalid pair in GBK, so this stream is read on both platforms at once.
  assert.equal(decode([Buffer.from([0x61, 0xe9]), Buffer.from([0x20, 0x62])]), 'aé b');
});

test('Python children are asked for UTF-8 only on Windows, and only for their own output', () => {
  assert.deepEqual(pythonUtf8Output('win32'), { PYTHONIOENCODING: 'utf-8' });
  assert.deepEqual(pythonUtf8Output('linux'), {});
});
