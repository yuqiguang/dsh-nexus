/** Decode each pipe independently. Unknown encodings are sampled through the first non-ASCII
 * line (at most 4096 bytes), so operating-system chunk boundaries do not decide the encoding.
 * Bytes can be ambiguous: UTF-8 is preferred; fallbacks are compatibility defaults, not a
 * claim to have detected the host console code page. Known producers should emit UTF-8.
 */
const SAMPLE_LIMIT = 4096;
const DEFAULT_FALLBACKS = process.platform === 'win32' ? ['gbk', 'windows-1252'] : ['windows-1252', 'gbk'];

export interface OutputDecoder {
  push(chunk: Buffer): string;
  /** Finish this stream. Repeated calls return an empty string. */
  flush(): string;
}

export function createOutputDecoder(fallbacks: readonly string[] = DEFAULT_FALLBACKS): OutputDecoder {
  let pending: Buffer = Buffer.alloc(0);
  let decoder: TextDecoder | undefined;
  let ended = false;
  const select = (bytes: Buffer, final: boolean) => {
    for (const encoding of ['utf-8', ...fallbacks]) {
      try {
        new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: !final });
        return new TextDecoder(encoding);
      } catch { /* Try the next supported encoding. */ }
    }
    return new TextDecoder('utf-8');
  };
  return {
    push(chunk) {
      if (ended || !chunk.length) return '';
      if (decoder) return decoder.decode(chunk, { stream: true });
      let text = '';
      // ASCII is common to all candidates and can be displayed without buffering or locking an encoding.
      if (!pending.length) {
        const first = chunk.findIndex(byte => byte >= 0x80);
        if (first === -1) return chunk.toString('ascii');
        text = chunk.subarray(0, first).toString('ascii');
        chunk = chunk.subarray(first);
      }
      const take = Math.min(chunk.length, SAMPLE_LIMIT - pending.length);
      const sample = Buffer.concat([pending, chunk.subarray(0, take)]);
      const newline = sample.indexOf(0x0a);
      if (newline === -1 && sample.length < SAMPLE_LIMIT) { pending = sample; return text; }
      const end = newline === -1 ? sample.length : newline + 1;
      decoder = select(sample.subarray(0, end), newline !== -1);
      text += decoder.decode(sample, { stream: true });
      text += decoder.decode(chunk.subarray(take), { stream: true });
      pending = Buffer.alloc(0);
      return text;
    },
    flush() {
      if (ended) return '';
      ended = true;
      decoder ??= select(pending, true);
      const text = decoder.decode(pending);
      pending = Buffer.alloc(0);
      return text;
    },
  };
}

/**
 * Python picks its stdout encoding from the console code page on Windows. Asking it for UTF-8 keeps the fix at the source,
 * so the fallback above stays a safety net for other programs rather than the mechanism we rely on. Only the I/O encoding
 * is set: `PYTHONUTF8` would also change how the child opens files, which is not ours to decide.
 */
export function pythonUtf8Output(platform = process.platform): NodeJS.ProcessEnv {
  return platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {};
}
