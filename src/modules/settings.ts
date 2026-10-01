import type { Records } from '../channels/records.js';
import { ChannelError } from '../channels/types.js';

export const MODULE_KEYS = ['memory', 'mail', 'agenda', 'documents'] as const;
export type ModuleKey = typeof MODULE_KEYS[number];
export type ModuleFlags = Record<ModuleKey, boolean>;
export interface ModuleRecord { version: 1; revision: number; enabled: ModuleFlags }
export interface ModulesView {
  revision: number;
  active: ModuleFlags;
  saved: ModuleFlags;
  pendingRestart: boolean;
  nativeRemindersAvailable: boolean;
}

// Older releases have no installation marker. Absence of settings cannot safely
// distinguish a fresh install from an existing profile with unsaved defaults.
// Preserve their behavior until the user explicitly chooses a module set.
export function compatibleModules(): ModuleFlags { return { memory: true, mail: true, agenda: true, documents: true }; }

function flags(raw: unknown, code: string): ModuleFlags {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ChannelError(code);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== MODULE_KEYS.length || MODULE_KEYS.some(key => typeof value[key] !== 'boolean')) throw new ChannelError(code);
  return Object.fromEntries(MODULE_KEYS.map(key => [key, value[key]])) as ModuleFlags;
}

function decode(raw: unknown): ModuleRecord {
  if (raw === undefined) return { version: 1, revision: 0, enabled: compatibleModules() };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ChannelError('invalid_saved_record');
  const record = raw as ModuleRecord;
  if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new ChannelError('invalid_saved_record');
  return { version: 1, revision: record.revision, enabled: flags(record.enabled, 'invalid_saved_record') };
}

/** The immutable startup snapshot gates runtime installation; writes only affect the next start. */
export class ModuleSettings {
  private constructor(private readonly records: Records, readonly active: Readonly<ModuleFlags>, private readonly nativeRemindersAvailable: boolean) {}

  static async open(records: Records, nativeRemindersAvailable = false): Promise<ModuleSettings> {
    const record = decode(await records.read('settings'));
    return new ModuleSettings(records, Object.freeze(record.enabled), nativeRemindersAvailable);
  }

  private view(record: ModuleRecord): ModulesView {
    return { revision: record.revision, active: { ...this.active }, saved: { ...record.enabled },
      pendingRestart: MODULE_KEYS.some(key => record.enabled[key] !== this.active[key]), nativeRemindersAvailable: this.nativeRemindersAvailable };
  }

  async handle(method: string, payload: unknown = {}): Promise<ModulesView> {
    if (method === 'list') return this.view(decode(await this.records.read('settings')));
    if (method !== 'save') throw new ChannelError('unknown_action');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new ChannelError('invalid_revision');
    const enabled = flags(input.enabled, 'invalid_configuration');
    const result = await this.records.modify('settings', async current => {
      const previous = decode(current);
      if (previous.revision !== input.revision) throw new ChannelError('configuration_changed');
      return { version: 1, revision: previous.revision + 1, enabled };
    });
    return this.view(decode(result));
  }
}
