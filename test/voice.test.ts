import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmToWav, codecLabel, silkToWav, wavPcm } from '../src/wechat/voice.js';

test('the first bytes name the container, so a clip nothing here decodes is still identifiable', () => {
  assert.equal(codecLabel(Buffer.from([0x02, ...Buffer.from('#!SILK_V3')])), 'silk-v3');
  assert.equal(codecLabel(Buffer.from('OggS....')), 'ogg');
  assert.equal(codecLabel(Buffer.from('RIFFxxxxWAVE')), 'wav');
  assert.equal(codecLabel(Buffer.from('#!AMR\nxxxx')), 'amr');
  assert.match(codecLabel(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe])), /^unknown\(deadbeefcafe\)$/);
  assert.equal(codecLabel(Buffer.alloc(0)), 'unknown()');
});

test('a SILK clip decodes back to a WAV', async () => {
  const wav = pcmToWav(Buffer.alloc(24_000 * 2));
  const encoded = await wavToSilkRoundTrip(wav);
  assert.ok(encoded);
  const back = await silkToWav(encoded);
  assert.equal(back?.subarray(0, 4).toString('latin1'), 'RIFF');
});

/** silk-wasm has no encoder in this build, so a clip is made the way one arrives: decoded from a known-good header. */
async function wavToSilkRoundTrip(wav: Buffer): Promise<Buffer | undefined> {
  const codec = await import('silk-wasm');
  const pcm = wavPcm(wav);
  if (!pcm) return undefined;
  const encoded = await codec.encode(pcm.samples, pcm.sampleRate);
  return encoded.data.byteLength > 0 ? Buffer.from(encoded.data) : undefined;
}

test('a streamed WAV with unknown sizes and a LIST chunk before the data still yields its PCM', () => {
  const pcm = Buffer.alloc(24_000 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(0xffffffff, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([6, 0, 0, 0]), Buffer.from('INFOab')]);
  header.write('data', 36); header.writeUInt32LE(0xffffffff, 40);
  const streamed = Buffer.concat([header.subarray(0, 36), list, header.subarray(36), pcm]);
  assert.equal(wavPcm(streamed)?.samples.length, pcm.length);
  assert.equal(wavPcm(streamed)?.sampleRate, 24_000);
  assert.equal(wavPcm(Buffer.from('RIFFxxxxWAVE')), undefined);
  assert.equal(wavPcm(Buffer.from('not a wav')), undefined);
});
