import { createHash } from 'node:crypto';

/** A review projection, never executable source or proof of a MIME type. Preserve every byte outside opaque payloads.
 * Restrict to quoted, unescaped base64 data URIs with passive media MIME labels; SVG/HTML/JS and malformed URIs stay intact.
 * Even a labelled audio payload can be decoded and executed by surrounding code, so callers must mark evidence incomplete.
 */
export function mediaEvidence(source: string): { text: string; count: number } | undefined {
  let count = 0;
  const text = source.replace(/(["'])data:((?:audio\/(?:mpeg|mp3|wav|ogg|webm)|video\/(?:mp4|webm)|image\/(?:png|jpeg|gif|webp)));base64,([A-Za-z0-9+/]{1024,}={0,2})\1/g,
    (match, quote: string, mime: string, payload: string) => {
      if (payload.length % 4 !== 0) return match;
      count++;
      const digest = createHash('sha256').update(payload).digest('hex');
      return `${quote}data:${mime};base64,[omitted payload: chars=${payload.length}, sha256=${digest}]${quote}`;
    });
  return count ? { text, count } : undefined;
}
