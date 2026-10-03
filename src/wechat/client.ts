import { randomBytes } from 'node:crypto';
import { ChannelError } from '../channels/types.js';
import { wechatBaseUrl } from '../channels/store.js';
import { retryable, wait, type Wait } from './retry.js';
import { downloadUrl, ItemType, UploadType, WECHAT_CDN_BASE_URL, type PreparedUpload, type WechatItem, type WechatMediaRef } from './media.js';
import { dualStackFetch } from './http.js';
import { WechatRequestError } from './errors.js';

export interface WechatMessage {
  message_id?: string | number;
  from_user_id?: string;
  group_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: WechatItem[];
}
export interface WechatUpdates { msgs?: WechatMessage[]; get_updates_buf?: string }
export interface WechatQrStatus {
  status: string;
  bot_token?: string;
  baseurl?: string;
  ilink_user_id?: string;
  ilink_bot_id?: string;
  redirect_host?: string;
}

/** iLink protocol, checked against @tencent-weixin/openclaw-weixin 2.4.8. */
export class WechatClient {
  /** The CDN is dual-stack and slow to connect from some networks; the global fetch's 250 ms per-address budget times out there (see http.ts). A fixture fetch is used for both. */
  private readonly cdnFetch: typeof fetch;

  constructor(private baseUrl = 'https://ilinkai.weixin.qq.com', private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch, private readonly sleep: Wait = wait,
    private readonly cdnBaseUrl = WECHAT_CDN_BASE_URL) {
    this.baseUrl = wechatBaseUrl(baseUrl);
    this.cdnFetch = fetchImpl === fetch ? dualStackFetch : fetchImpl;
  }

  redirect(host: string): void { this.baseUrl = wechatBaseUrl(`https://${host}`); }

  async qr(signal: AbortSignal): Promise<{ qrcode: string; qrcode_img_content?: string }> {
    const value = await this.request<{ qrcode: string; qrcode_img_content?: string }>('POST',
      '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, signal);
    if (!value.qrcode || typeof value.qrcode !== 'string' || value.qrcode.length > 8192) throw new ChannelError('invalid_qr_response');
    return value;
  }

  async qrStatus(code: string, signal: AbortSignal): Promise<WechatQrStatus> {
    try { return await this.request('GET', `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(code)}`, undefined, signal, 40_000); }
    catch (error) {
      if (!signal.aborted && error instanceof ChannelError && error.code === 'connection_timeout') return { status: 'wait' };
      throw error;
    }
  }

  async updates(cursor: string, signal: AbortSignal): Promise<WechatUpdates | undefined> {
    try { return await this.request('POST', '/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: this.baseInfo() }, signal, 40_000); }
    catch (error) {
      // A normal long-poll timeout is no response, not proof that authentication succeeded.
      if (!signal.aborted && error instanceof ChannelError && error.code === 'connection_timeout') return undefined;
      throw error;
    }
  }

  async sendText(ownerId: string, contextToken: string, text: string, deliveryId: string, signal: AbortSignal): Promise<void> {
    await this.sendItem(ownerId, contextToken, { type: ItemType.text, text_item: { text } }, deliveryId, signal);
  }

  /** One item per message, as the reference client does; the client id keeps retries idempotent on the server. */
  async sendItem(ownerId: string, contextToken: string, item: WechatItem, deliveryId: string, signal: AbortSignal): Promise<void> {
    const body = {
      msg: { from_user_id: '', to_user_id: ownerId, client_id: `nexus:${deliveryId}`, message_type: 2,
        message_state: 2, context_token: contextToken, item_list: [item] },
      base_info: this.baseInfo(),
    };
    for (let attempt = 0; ; attempt++) {
      try { await this.request('POST', '/ilink/bot/sendmessage', body, signal); return; }
      catch (error) {
        const milliseconds = [400, 1200][attempt];
        if (signal.aborted || !retryable(error) || milliseconds === undefined) throw error;
        await this.sleep(milliseconds, signal);
      }
    }
  }

  /**
   * Upload one encrypted object: ask iLink for the CDN slot, POST the ciphertext,
   * and return the download parameter the outbound item must carry.
   */
  async upload(ownerId: string, kind: 'image' | 'file' | 'voice', upload: PreparedUpload, signal: AbortSignal): Promise<string> {
    const slot = await this.request<{ upload_full_url?: string; upload_param?: string }>('POST', '/ilink/bot/getuploadurl', {
      filekey: upload.filekey, media_type: kind === 'image' ? UploadType.image : kind === 'voice' ? UploadType.voice : UploadType.file, to_user_id: ownerId,
      rawsize: upload.rawsize, rawfilemd5: upload.rawfilemd5, filesize: upload.ciphertext.length, no_need_thumb: true,
      aeskey: upload.aesKey.toString('hex'), base_info: this.baseInfo(),
    }, signal);
    const target = slot.upload_full_url?.trim() || (slot.upload_param
      ? `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(slot.upload_param)}&filekey=${encodeURIComponent(upload.filekey)}` : '');
    if (!target) throw new ChannelError('wechat_upload_failed');
    const response = await this.cdn(target, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(upload.ciphertext) }, signal, 120_000);
    if (response.status >= 500) throw new ChannelError('server_unavailable');
    const param = response.headers.get('x-encrypted-param');
    if (response.status !== 200 || !param) throw new ChannelError('wechat_upload_failed');
    return param;
  }

  /** Fetch one inbound object's ciphertext, refusing anything over `maxBytes` before buffering it. */
  async download(ref: WechatMediaRef, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.cdn(downloadUrl(ref, this.cdnBaseUrl), { method: 'GET' }, signal, 120_000);
    if (response.status >= 500) throw new ChannelError('server_unavailable');
    if (!response.ok || !response.body) throw new ChannelError('wechat_download_failed');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(declared) && declared > maxBytes) throw new ChannelError('wechat_media_too_large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new ChannelError('wechat_media_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  }

  private async cdn(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response> {
    try {
      return await this.cdnFetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    } catch (error) {
      if (signal.aborted) throw new ChannelError('connection_cancelled');
      if (error instanceof ChannelError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new ChannelError('connection_timeout');
      throw new ChannelError('connection_failed');
    }
  }

  private baseInfo() { return { channel_version: '2.4.8', bot_agent: 'Nexus Next' }; }

  private async request<T>(method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs = 15_000): Promise<T> {
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x020408) };
    if (method === 'POST') {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      const operation = path === '/ilink/bot/sendmessage' ? 'send' : path === '/ilink/bot/getupdates' ? 'poll' : 'other';
      const rejected = operation === 'send' ? 'wechat_send_rejected' : 'wechat_request_failed';
      let value: Record<string, unknown> = {};
      try {
        // Keep opaque 64-bit message IDs exact. Error bodies contribute numeric codes only.
        const parsed = JSON.parse(await response.text(), (key: string, value: unknown, context?: { source?: string }) =>
          key === 'message_id' && typeof value === 'number' && context?.source ? context.source : value);
        if (parsed && typeof parsed === 'object') value = parsed;
        else if (response.ok) throw new Error('invalid response');
      } catch (error) { if (response.ok) throw error; }
      const numeric = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) ? v
        : typeof v === 'string' && /^-?\d{1,15}$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined;
      const ret = numeric(value.ret), errcode = numeric(value.errcode);
      const codes = { operation, httpStatus: response.status, ...(ret !== undefined ? { ret } : {}), ...(errcode !== undefined ? { errcode } : {}) } as const;
      if (response.status === 401 || errcode === -14 || ret === -14) throw new WechatRequestError('authentication_failed', codes);
      // Polling conflict is specific to the receive endpoint; a send refusal is not proof of a second poller.
      if (response.status === 403 && operation === 'poll') throw new WechatRequestError('wechat_poller_conflict', codes);
      if (response.status === 429) throw new WechatRequestError('rate_limited', codes);
      if (response.status >= 500) throw new WechatRequestError('server_unavailable', codes);
      if (!response.ok || (value.ret !== undefined && ret !== 0) || (value.errcode !== undefined && errcode !== 0)) throw new WechatRequestError(rejected, codes);
      return value as T;
    } catch (error) {
      if (signal.aborted) throw new ChannelError('connection_cancelled');
      if (error instanceof ChannelError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new ChannelError('connection_timeout');
      throw new ChannelError('connection_failed');
    }
  }
}
