import { randomBytes } from 'node:crypto';
import type { Records } from '../channels/records.js';
import { ChannelError } from '../channels/types.js';
import { DEFAULT_PERSONA, parsePersona, type PersonaSettings } from './persona.js';
import { redactSpeech, speechInput, type SpeechSettings, type SpeechView } from './speech.js';
import { DEFAULT_ROTATION, ROTATION_LIMITS, type RotationSettings } from '../sessions/index.js';

/** Assistant-wide preferences: clock, quiet hours, daily briefing, and the inbound hook secret. */
export interface AssistantSettingsRecord {
  version: 1;
  revision: number;
  timeZone: string;
  /** Local wall-clock `HH:MM`; pushes between start and end are held. Absent means no quiet hours. */
  quietStart?: string;
  quietEnd?: string;
  /** Local `HH:MM` at which the daily briefing is sent; absent disables it. */
  briefingTime?: string;
  /** Bearer token external systems present to the inbound hook; empty means the hook is off. */
  hookToken: string;
  /** Absent in records written before the persona existed; read as the default. */
  persona?: PersonaSettings;
  /** Speech-to-text service for voice clips without a transcript; absent means none. */
  speech?: SpeechSettings;
  /** When a chat's session is replaced by a fresh one; absent in older records, read as the default. */
  rotation?: RotationSettings;
}

export interface AssistantSettingsView {
  revision: number;
  timeZone: string;
  quietStart?: string;
  quietEnd?: string;
  briefingTime?: string;
  hookEnabled: boolean;
  persona: PersonaSettings;
  speech: SpeechView;
  rotation: RotationSettings;
}

export const SETTINGS_KEY = 'settings';
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export function defaultAssistantSettings(): AssistantSettingsRecord {
  return { version: 1, revision: 0, timeZone: DEFAULT_TIME_ZONE, hookToken: '' };
}

export function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function clock(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) throw new ChannelError('invalid_clock_time');
  return value.trim();
}

function decode(raw: unknown): AssistantSettingsRecord | undefined {
  if (raw === undefined) return undefined;
  const value = raw as AssistantSettingsRecord;
  if (!value || typeof value !== 'object' || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.timeZone !== 'string' || typeof value.hookToken !== 'string'
    || [value.quietStart, value.quietEnd, value.briefingTime].some(item => item !== undefined && typeof item !== 'string')) throw new ChannelError('invalid_saved_record');
  try { if (value.persona !== undefined) parsePersona(value.persona); } catch { throw new ChannelError('invalid_saved_record'); }
  const speech = value.speech;
  if (speech !== undefined && (!speech || typeof speech !== 'object' || typeof speech.baseUrl !== 'string' || typeof speech.model !== 'string' || typeof speech.apiKey !== 'string'
    )) {
    throw new ChannelError('invalid_saved_record');
  }
  const rotation = value.rotation;
  if (rotation !== undefined && (!rotation || typeof rotation !== 'object' || typeof rotation.daily !== 'boolean' || !Number.isSafeInteger(rotation.contextTokens) || rotation.contextTokens < 0)) {
    throw new ChannelError('invalid_saved_record');
  }
  return structuredClone(value);
}

/** The rotation fields of a save request; a missing object keeps the previous value. */
export function rotationInput(raw: unknown, previous: RotationSettings): RotationSettings {
  if (raw === undefined) return previous;
  if (!raw || typeof raw !== 'object') throw new ChannelError('invalid_rotation');
  const input = raw as Record<string, unknown>;
  const daily = input.daily === undefined ? previous.daily : input.daily;
  const contextTokens = input.contextTokens === undefined || input.contextTokens === '' ? previous.contextTokens : Number(input.contextTokens);
  if (typeof daily !== 'boolean' || !Number.isSafeInteger(contextTokens) || contextTokens < 0 || contextTokens > ROTATION_LIMITS.maxContextTokens) throw new ChannelError('invalid_rotation');
  return { daily, contextTokens };
}

export function redactAssistant(settings: AssistantSettingsRecord): AssistantSettingsView {
  // `voiceReply` was the spoken-reply switch; a spoken reply is gone, so the field is only stripped, never read.
  const { hookToken, version: _version, persona, speech, rotation, ...rest } = settings;
  return { ...rest, hookEnabled: hookToken.length > 0, persona: persona ?? DEFAULT_PERSONA, speech: redactSpeech(speech),
    rotation: rotation ?? DEFAULT_ROTATION };
}

export class AssistantSettingsStore {
  constructor(private readonly records: Records) {}

  async read(): Promise<AssistantSettingsRecord> {
    return decode(await this.records.read(SETTINGS_KEY)) ?? defaultAssistantSettings();
  }

  private async modify(expectedRevision: number, change: (previous: AssistantSettingsRecord) => AssistantSettingsRecord): Promise<AssistantSettingsRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ChannelError('invalid_revision');
    const result = await this.records.modify(SETTINGS_KEY, async current => {
      const previous = decode(current) ?? defaultAssistantSettings();
      if (previous.revision !== expectedRevision) throw new ChannelError('configuration_changed');
      return change(previous);
    });
    return decode(result)!;
  }

  save(expectedRevision: number, input: Record<string, unknown>): Promise<AssistantSettingsRecord> {
    return this.modify(expectedRevision, previous => {
      const timeZone = typeof input.timeZone === 'string' && input.timeZone.trim() ? input.timeZone.trim() : previous.timeZone;
      if (!validTimeZone(timeZone)) throw new ChannelError('invalid_time_zone');
      const quietStart = clock(input.quietStart);
      const quietEnd = clock(input.quietEnd);
      if ((quietStart === undefined) !== (quietEnd === undefined) || (quietStart !== undefined && quietStart === quietEnd)) throw new ChannelError('invalid_quiet_hours');
      const briefingTime = clock(input.briefingTime);
      // Cleared fields are omitted, not stored as undefined.
      const persona = parsePersona(input.persona, previous.persona ?? DEFAULT_PERSONA);
      const speech = speechInput(input.speech, previous.speech);
      const rotation = rotationInput(input.rotation, previous.rotation ?? DEFAULT_ROTATION);
      return { version: 1, revision: previous.revision + 1, timeZone, hookToken: previous.hookToken, persona, rotation,
        ...(quietStart ? { quietStart, quietEnd } : {}), ...(briefingTime ? { briefingTime } : {}), ...(speech ? { speech } : {}) };
    });
  }

  /** Forget the speech service and its key. */
  clearSpeech(expectedRevision: number): Promise<AssistantSettingsRecord> {
    return this.modify(expectedRevision, previous => { const { speech: _speech, ...rest } = previous; return { ...rest, revision: previous.revision + 1 }; });
  }

  /** Mint a new hook token (or turn the hook off); the token itself is returned once to the caller, never through the view. */
  rotateHook(expectedRevision: number, enabled: boolean): Promise<AssistantSettingsRecord> {
    return this.modify(expectedRevision, previous => ({ ...previous, revision: previous.revision + 1, hookToken: enabled ? randomBytes(24).toString('base64url') : '' }));
  }
}
