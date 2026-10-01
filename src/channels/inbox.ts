import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localDate } from '../assistant/clock.js';
import type { InboundAttachment } from './protocol.js';

/** Files the user sends from a phone land here, one directory per local day, and the model is told the path. */
export const INBOX_DIR = 'inbox';
/** Larger inbound files are refused before download; the native image store's default limit is the same 20 MiB. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

export interface SavedAttachment { kind: 'image' | 'file' | 'voice'; name: string; path: string; bytes: number }

/** A display name from the wire is never a path: strip separators, control characters, and leading dots. */
export function safeName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '').normalize('NFC').replace(/[\\/\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || fallback;
}

function extensionFor(attachment: InboundAttachment): string {
  if (attachment.kind === 'voice') return 'wav';
  if (attachment.kind !== 'image') return 'bin';
  const b = attachment.bytes;
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF') return 'webp';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  return 'img';
}

function stamp(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(now));
  return ['hour', 'minute', 'second'].map(type => parts.find(part => part.type === type)?.value ?? '00').join('');
}

/**
 * Save one attachment under `inbox/<local date>/`. Saving the same bytes under
 * the same name again (a redelivered message after a restart) returns the
 * existing file; a different file with the same name gets a numbered suffix.
 */
export async function saveInbound(workspace: string, attachment: InboundAttachment, now = Date.now(), timeZone = 'Asia/Shanghai'): Promise<SavedAttachment> {
  const day = localDate(now, timeZone);
  const directory = join(workspace, INBOX_DIR, day);
  await mkdir(directory, { recursive: true });
  const fallback = `${attachment.kind === 'image' ? 'image' : attachment.kind === 'voice' ? 'voice' : 'file'}-${stamp(now, timeZone)}.${extensionFor(attachment)}`;
  const base = safeName(attachment.name, fallback);
  const dot = base.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : `${stem}-${attempt + 1}${extension}`;
    const target = join(directory, name);
    try {
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(attachment.bytes); } finally { await handle.close(); }
      return { kind: attachment.kind, name, path: `${INBOX_DIR}/${day}/${name}`, bytes: attachment.bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await stat(target);
      if (existing.isFile() && existing.size === attachment.bytes.length && (await readFile(target)).equals(attachment.bytes)) {
        return { kind: attachment.kind, name, path: `${INBOX_DIR}/${day}/${name}`, bytes: attachment.bytes.length };
      }
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
