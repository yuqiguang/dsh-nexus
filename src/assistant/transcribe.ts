import { ChannelError } from '../channels/types.js';
import { dualStackFetch } from '../wechat/http.js';
import { multipart, type SpeechSettings } from './speech.js';

const REQUEST_TIMEOUT_MS = 60_000;

/** Transcribe one WAV clip; the result is the trimmed text. Errors carry a code the bridge can explain to the user. */
export async function transcribeWav(speech: SpeechSettings, wav: Buffer, signal: AbortSignal, fetchImpl: typeof fetch = dualStackFetch): Promise<string> {
  const { body, contentType } = multipart({ model: speech.model, response_format: 'json' }, { field: 'file', name: 'voice.wav', type: 'audio/wav', bytes: wav });
  let response: Response;
  try {
    response = await fetchImpl(`${speech.baseUrl}/audio/transcriptions`, { method: 'POST', body: new Uint8Array(body), signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      headers: { 'Content-Type': contentType, Accept: 'application/json', ...(speech.apiKey ? { Authorization: `Bearer ${speech.apiKey}` } : {}) } });
  } catch (error) {
    if (signal.aborted) throw new ChannelError('connection_cancelled');
    throw new ChannelError(error instanceof Error && error.name === 'TimeoutError' ? 'connection_timeout' : 'connection_failed');
  }
  if (response.status === 401 || response.status === 403) throw new ChannelError('speech_unauthorized');
  if (!response.ok) throw new ChannelError('speech_failed');
  let text: string;
  try {
    const parsed = await response.json() as { text?: unknown };
    text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  } catch { throw new ChannelError('speech_failed'); }
  if (!text) throw new ChannelError('speech_empty');
  return text;
}
