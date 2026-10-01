/**
 * WeChat declares its own voice clips Speex wideband at 16 kHz (the proto's `encode_type` 4, read off an item the
 * WeChat app itself sent on 2026-09-22). Nothing here encodes Speex: iLink accepts an outbound voice item but the
 * WeChat client renders nothing for it, in both upload slots and with either codec, so the outbound path was
 * removed rather than left sending items nobody can see. What is left is the inbound side.
 */
export const SILK_SAMPLE_RATE = 24_000;

/** Wrap mono pcm_s16le samples in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = SILK_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/**
 * Decode a SILK clip to WAV, for the senders that use SILK. WeChat's own clips declare Speex
 * (`encode_type` 4 at 16 kHz) and nothing here decodes those yet; `codecLabel` names the container
 * when one arrives without a transcript, so the decoder can be written against real bytes.
 * `undefined` when the bytes are not SILK or the decoder fails.
 */
export async function silkToWav(silk: Buffer): Promise<Buffer | undefined> {
  try {
    const codec = await import('silk-wasm');
    if (!codec.isSilk(silk)) return undefined;
    const decoded = await codec.decode(silk, SILK_SAMPLE_RATE);
    return decoded.data.byteLength > 0 ? pcmToWav(decoded.data) : undefined;
  } catch { return undefined; }
}

/** What the first bytes say a clip is, so a decode failure can be told apart from a container nothing here reads. */
export function codecLabel(bytes: Buffer): string {
  const head = bytes.subarray(0, 12);
  if (head.toString('latin1', 1, 10) === '#!SILK_V3') return 'silk-v3';
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') return 'wav';
  if (head.subarray(0, 5).toString('latin1') === '#!AMR') return 'amr';
  return `unknown(${head.toString('hex')})`;
}

/**
 * The mono 16-bit PCM inside a WAV, found by walking its chunks. A streamed WAV writes 0xFFFFFFFF for the RIFF and
 * data sizes because it does not know them yet (seen 2026-09-22 on a text-to-speech response, and it is what any
 * chunked writer produces); silk-wasm refuses that header, so the sizes are taken from the bytes actually present.
 * Stereo or non-16-bit audio comes back `undefined`.
 */
export function wavPcm(wav: Buffer): { samples: Buffer; sampleRate: number } | undefined {
  if (wav.length < 12 || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') return undefined;
  let format: { channels: number; sampleRate: number; bits: number } | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('latin1', offset, offset + 4);
    const declared = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const size = Math.min(declared, wav.length - start);
    if (id === 'fmt ' && size >= 16) format = { channels: wav.readUInt16LE(start + 2), sampleRate: wav.readUInt32LE(start + 4), bits: wav.readUInt16LE(start + 14) };
    if (id === 'data') {
      if (!format || format.channels !== 1 || format.bits !== 16 || format.sampleRate <= 0) return undefined;
      const samples = wav.subarray(start, start + size - (size % 2));
      return samples.length ? { samples, sampleRate: format.sampleRate } : undefined;
    }
    offset = start + size + (size % 2);
  }
  return undefined;
}
