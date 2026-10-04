/**
 * Child output arrives as bytes and the owner reads it as text. On Windows a program's standard output follows the console
 * code page rather than UTF-8, so a Python script printing Chinese into a pipe writes GBK, and decoding that as UTF-8 reaches
 * the owner as a wall of U+FFFD (ct-4c671559). This decoder holds back only the bytes that could still be part of a character
 * split across two chunks, tries strict UTF-8 first, and falls back to the platform code page instead of showing replacement
 * characters. Nothing here changes what the child writes; it only decides how those bytes are read back.
 */

/** Ordered candidates for a stream that is not valid UTF-8: the host's own code page first, then the other common one. */
const STREAM_ENCODINGS = process.platform === 'win32' ? ['gbk', 'windows-1252'] : ['windows-1252', 'gbk'];
const REPLACEMENT = '\uFFFD';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const probes = new Map<string, TextDecoder | null>();

function probe(encoding: string): TextDecoder | undefined {
  if (!probes.has(encoding)) {
    try { probes.set(encoding, new TextDecoder(encoding)); } catch { probes.set(encoding, null); }
  }
  return probes.get(encoding) ?? undefined;
}

/** How many trailing bytes could begin a character whose remaining bytes have not arrived yet. */
function holdBytes(encoding: string, buffer: Buffer): number {
  if (encoding === 'utf-8') {
    for (let back = 1; back <= 3 && back <= buffer.length; back++) {
      const byte = buffer[buffer.length - back]!;
      if ((byte & 0xc0) === 0x80) continue; // A continuation byte belongs to a lead byte further back.
      const need = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
      return need > back ? back : 0;
    }
    return 0;
  }
  // A two-byte code page (GBK, Big5, Shift_JIS, …) can be split after its lead byte; a single-byte page cannot be split.
  if (encoding === 'windows-1252' || encoding === 'latin1') return 0;
  const tail = buffer[buffer.length - 1]!;
  return tail >= 0x81 && tail <= 0xfe ? 1 : 0;
}

/** Replacement characters a candidate encoding produces for these bytes; `Infinity` when the runtime lacks the code page. */
function countBroken(encoding: string, bytes: Buffer): number {
  const decoder = probe(encoding);
  if (!decoder) return Number.POSITIVE_INFINITY;
  let broken = 0;
  for (const char of decoder.decode(bytes)) if (char === REPLACEMENT) broken++;
  return broken;
}

/**
 * Pick the code page that reads these bytes cleanly. Windows tries the local ANSI page first, other platforms the Latin-1
 * superset: both candidates decode almost any byte string, so the ordering decides the ties (and a Western Windows host
 * still gets `windows-1252`, because GBK leaves replacement characters on text that is not GBK).
 */
function chooseEncoding(bytes: Buffer): string | undefined {
  let best: string | undefined, broken = Number.POSITIVE_INFINITY;
  for (const encoding of STREAM_ENCODINGS) {
    const count = countBroken(encoding, bytes);
    if (count < broken) { best = encoding; broken = count; }
    if (broken === 0) break;
  }
  return best;
}

export interface OutputDecoder {
  /** Text decoded so far, excluding any bytes still held as an incomplete character. */
  push(chunk: Buffer): string;
  /** Whatever was still held; call once when the stream ends. Safe to call more than once. */
  flush(): string;
}

export function createOutputDecoder(): OutputDecoder {
  let pending: Buffer = Buffer.alloc(0);
  let encoding: string | undefined;
  const decode = (bytes: Buffer): string => {
    if (!bytes.length) return '';
    const chosen = encoding ? probe(encoding) : undefined;
    if (chosen) return chosen.decode(bytes);
    try { return utf8Strict.decode(bytes); }
    catch {
      encoding = chooseEncoding(bytes);
      return (encoding ? probe(encoding) : undefined)?.decode(bytes) ?? bytes.toString('utf8');
    }
  };
  return {
    push(chunk) {
      if (!chunk.length) return '';
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const hold = holdBytes(encoding ?? 'utf-8', pending);
      const head = pending.subarray(0, pending.length - hold);
      if (!head.length) return '';
      const text = decode(head);
      pending = pending.subarray(pending.length - hold);
      return text;
    },
    flush() {
      const text = decode(pending);
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
