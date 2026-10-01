import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ChannelError } from '../channels/types.js';

/** iLink message item types, checked against @tencent-weixin/openclaw-weixin 2.4.9 (proto MessageItemType). */
export const ItemType = { text: 1, image: 2, voice: 3, file: 4, video: 5 } as const;
/** proto UploadMediaType. */
export const UploadType = { image: 1, video: 2, file: 3, voice: 4 } as const;
export const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

export interface CdnMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string }
export interface WechatItem {
  type: number;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string; hd_size?: number; mid_size?: number };
  /** `playtime` is milliseconds; `encode_type` 4 is Speex (proto VoiceItem: 1 pcm, 2 adpcm, 3 feature, 4 speex, 5 amr, 6 silk, 7 mp3, 8 ogg-speex). */
  voice_item?: { media?: CdnMedia; text?: string; playtime?: number; encode_type?: number; sample_rate?: number; bits_per_sample?: number };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string | number };
  video_item?: { media?: CdnMedia; video_size?: number };
}

/** One downloadable inbound picture, document, or voice clip; the key is kept in whichever encoding the server used. */
export interface WechatMediaRef {
  kind: 'image' | 'file' | 'voice';
  name?: string;
  /** Voice clip length in seconds, as the server declared it. */
  seconds?: number;
  /** Ciphertext size the sender declared, when the item carries one. */
  declaredBytes?: number;
  encryptQueryParam?: string;
  fullUrl?: string;
  aesKey: Buffer;
}

/**
 * The server sends `aes_key` as base64 of either the raw 16 bytes (pictures)
 * or of the 32-character hex string (files, voice, video); `image_item.aeskey`
 * is the bare hex string.
 */
export function parseAesKey(value: string, hex = false): Buffer {
  const decoded = hex ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (decoded.length === 16) return decoded;
  const text = decoded.toString('latin1');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex');
  throw new ChannelError('wechat_media_key_invalid');
}

export function encryptMedia(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptMedia(ciphertext: Buffer, key: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new ChannelError('wechat_media_decrypt_failed'); }
}

/** PKCS#7 padded size of AES-128-ECB ciphertext. */
export function paddedSize(plaintextBytes: number): number { return Math.ceil((plaintextBytes + 1) / 16) * 16; }

function mediaRef(kind: WechatMediaRef['kind'], media: CdnMedia | undefined, key: string | undefined, hex: boolean,
  extra: Pick<WechatMediaRef, 'name' | 'declaredBytes' | 'seconds'>): WechatMediaRef | undefined {
  if (!media || (!media.encrypt_query_param && !media.full_url) || !key) return undefined;
  let aesKey: Buffer;
  try { aesKey = parseAesKey(key, hex); } catch { return undefined; }
  return { kind, aesKey, ...(media.encrypt_query_param ? { encryptQueryParam: media.encrypt_query_param } : {}),
    ...(media.full_url ? { fullUrl: media.full_url } : {}), ...extra };
}

/** Split a message into its text, downloadable media, and item kinds this version does not handle; `transcribed` when voice text was used. */
export function inboundItems(items: readonly WechatItem[] | undefined): { text: string; media: WechatMediaRef[]; unsupported: string[]; transcribed: boolean } {
  const texts: string[] = [];
  const media: WechatMediaRef[] = [];
  const unsupported: string[] = [];
  let transcribed = false;
  for (const item of items ?? []) {
    if (item.type === ItemType.text) { if (item.text_item?.text) texts.push(item.text_item.text); continue; }
    if (item.type === ItemType.image) {
      const image = item.image_item;
      const declared = image?.hd_size || image?.mid_size;
      const ref = image?.aeskey ? mediaRef('image', image.media, image.aeskey, true, declared ? { declaredBytes: declared } : {})
        : mediaRef('image', image?.media, image?.media?.aes_key, false, declared ? { declaredBytes: declared } : {});
      if (ref) media.push(ref); else unsupported.push('image');
      continue;
    }
    if (item.type === ItemType.file) {
      const file = item.file_item;
      const len = Number(file?.len);
      const ref = mediaRef('file', file?.media, file?.media?.aes_key, false, { ...(file?.file_name ? { name: file.file_name } : {}),
        ...(Number.isSafeInteger(len) && len > 0 ? { declaredBytes: paddedSize(len) } : {}) });
      if (ref) media.push(ref); else unsupported.push('file');
      continue;
    }
    // Voice usually arrives with the server's transcript, and that text is the message; without one the clip itself is fetched.
    if (item.type === ItemType.voice) {
      const voice = item.voice_item;
      if (voice?.text) { texts.push(voice.text); transcribed = true; continue; }
      const seconds = Number(voice?.playtime) / 1000;
      const ref = mediaRef('voice', voice?.media, voice?.media?.aes_key, false, Number.isFinite(seconds) && seconds > 0 ? { seconds } : {});
      if (ref) media.push(ref); else unsupported.push('voice');
      continue;
    }
    if (item.type === ItemType.video) { unsupported.push('video'); continue; }
  }
  return { text: texts.join('\n').trim(), media, unsupported, transcribed };
}

export function downloadUrl(ref: Pick<WechatMediaRef, 'encryptQueryParam' | 'fullUrl'>, cdnBaseUrl = WECHAT_CDN_BASE_URL): string {
  if (ref.fullUrl) return ref.fullUrl;
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(ref.encryptQueryParam ?? '')}`;
}

/** Everything the upload handshake and the outbound item need about one plaintext. */
export interface PreparedUpload {
  filekey: string;
  aesKey: Buffer;
  ciphertext: Buffer;
  rawsize: number;
  rawfilemd5: string;
}

export function prepareUpload(plaintext: Buffer): PreparedUpload {
  const aesKey = randomBytes(16);
  return { filekey: randomBytes(16).toString('hex'), aesKey, ciphertext: encryptMedia(plaintext, aesKey), rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex') };
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** Pictures are shown inline by the WeChat client; everything else is a document card. */
export function outboundKind(name: string): 'image' | 'file' {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return name.includes('.') && IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file';
}

/** The outbound item for an uploaded object; the key travels as base64 of its hex spelling, as the reference client sends it. */
export function mediaItem(kind: 'image' | 'file', name: string, upload: PreparedUpload, downloadParam: string): WechatItem {
  const media: CdnMedia = { encrypt_query_param: downloadParam, aes_key: Buffer.from(upload.aesKey.toString('hex')).toString('base64'), encrypt_type: 1 };
  return kind === 'image' ? { type: ItemType.image, image_item: { media, mid_size: upload.ciphertext.length } }
    : { type: ItemType.file, file_item: { media, file_name: name, len: String(upload.rawsize) } };
}

/** Sniff the encoded raster format the native attachment store accepts. */
export function imageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return undefined;
}
