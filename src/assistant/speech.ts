import { ChannelError } from '../channels/types.js';

/**
 * Speech-to-text for voice clips that arrive without a transcript. Any service
 * with an OpenAI-compatible `POST /audio/transcriptions` works: OpenAI itself,
 * Groq, SiliconFlow (SenseVoice), or a local whisper server exposing that
 * route. The key is a secret and never returns to the settings page.
 */
export interface SpeechSettings {
  /** Base URL up to and excluding `/audio/transcriptions`, e.g. `https://api.siliconflow.cn/v1`. */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface SpeechView { baseUrl: string; model: string; apiKeyConfigured: boolean }

export const SPEECH_LIMITS = { urlChars: 300, modelChars: 120, keyChars: 512 } as const;

export function redactSpeech(speech: SpeechSettings | undefined): SpeechView {
  return speech ? { baseUrl: speech.baseUrl, model: speech.model, apiKeyConfigured: speech.apiKey.length > 0 }
    : { baseUrl: '', model: '', apiKeyConfigured: false };
}

/** Validate the settings page's speech card; an empty key keeps the saved one, and clearing the URL removes the service. */
export function speechInput(raw: unknown, previous: SpeechSettings | undefined): SpeechSettings | undefined {
  if (raw === undefined || raw === null) return previous;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ChannelError('invalid_configuration');
  const input = raw as Record<string, unknown>;
  const text = (value: unknown, max: number) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.trim().length > max) throw new ChannelError('invalid_configuration');
    return value.trim();
  };
  const baseUrl = (text(input.baseUrl, SPEECH_LIMITS.urlChars) ?? previous?.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ChannelError('invalid_speech_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new ChannelError('invalid_speech_url');
  const model = text(input.model, SPEECH_LIMITS.modelChars) ?? previous?.model ?? '';
  if (!model) throw new ChannelError('invalid_speech_model');
  const apiKey = text(input.apiKey, SPEECH_LIMITS.keyChars) || previous?.apiKey || '';
  return { baseUrl, model, apiKey };
}

export function speechConfigured(speech: SpeechSettings | undefined): speech is SpeechSettings {
  return !!speech && speech.baseUrl.length > 0 && speech.model.length > 0;
}

/** Build a multipart/form-data body by hand so it can travel over the dual-stack-safe fetch, which takes bytes only. */
export function multipart(fields: Record<string, string>, file: { field: string; name: string; type: string; bytes: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----nexus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
