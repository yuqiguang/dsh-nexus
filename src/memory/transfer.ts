import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ChannelError } from '../channels/types.js';
import { LIMITS, MemoryLimitError, memoryTags, validateMemory, type MemoryStore } from './store.js';

export const MAX_MEMORY_JSON_BYTES = 2 * 1024 * 1024;
export interface MemorySelection { profile: boolean; events: boolean; proposals: boolean }
export interface MemoryImportPreview {
  token: string; source: string; exportedAt: number; add: number; overwrite: number; skip: number; conflicts: number;
  profile: number; events: number; proposals: number;
}
const tags = z.array(z.string().max(100)).max(LIMITS.tagsPerEvent).optional();
const archiveSchema = z.object({
  format: z.literal('nexus-memory').optional(), version: z.literal(1).optional(), exportedAt: z.number().int().nonnegative(),
  scope: z.object({ label: z.string().max(2000) }).optional(),
  profile: z.array(z.object({ key: z.string(), value: z.string() })).max(LIMITS.profileEntries),
  events: z.array(z.object({ text: z.string(), tags, at: z.number().int().nonnegative() })).max(LIMITS.events),
  proposals: z.array(z.object({ kind: z.enum(['profile', 'event']), key: z.string().optional(), text: z.string(), tags,
    at: z.number().int().nonnegative() })).max(LIMITS.proposals),
});
export function memorySelection(value: unknown): MemorySelection {
  const parsed = z.object({ profile: z.boolean(), events: z.boolean(), proposals: z.boolean() }).safeParse(value);
  if (!parsed.success || !Object.values(parsed.data).some(Boolean)) throw new ChannelError('invalid_configuration');
  return parsed.data;
}

/** Portable records only. Never import session bindings, policies, or an archive's scope as authority. */
export function planMemoryImport(store: MemoryStore, json: unknown, selection: MemorySelection, conflict: unknown, targetScopeId: string) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_MEMORY_JSON_BYTES) throw new ChannelError('memory_import_invalid');
  if (conflict !== 'keep' && conflict !== 'overwrite') throw new ChannelError('invalid_configuration');
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new ChannelError('memory_import_invalid'); }
  const result = archiveSchema.safeParse(raw);
  if (!result.success) throw new ChannelError('memory_import_invalid');
  const archive = result.data;
  const profile = archive.profile.map(item => { const valid = validateMemory('profile', item.value, item.key); return { key: valid.key!, value: valid.text }; });
  const events = archive.events.map(item => ({ ...item, text: validateMemory('event', item.text).text, tags: memoryTags(item.tags) }));
  const proposals = archive.proposals.map(item => ({ ...item, ...validateMemory(item.kind, item.text, item.key), tags: memoryTags(item.tags) }));
  const current = store.export();
  const existingProfile = new Map(current.profile.map(item => [item.key, item.value]));
  const existingEvents = new Set(current.events.map(item => item.text));
  const proposalKey = (item: { kind: string; key?: string; text: string }) => JSON.stringify([item.kind, item.key, item.text]);
  const existingProposals = new Set(current.proposals.map(proposalKey));
  const writes = { profile: [] as typeof profile, events: [] as typeof events, proposals: [] as typeof proposals };
  let add = 0, overwrite = 0, skip = 0, conflicts = 0;
  if (selection.profile) for (const item of profile) {
    const previous = existingProfile.get(item.key);
    if (previous === item.value) { skip++; continue; }
    if (previous !== undefined) {
      conflicts++;
      if (conflict === 'keep') { skip++; continue; }
      overwrite++;
    } else add++;
    existingProfile.set(item.key, item.value); writes.profile.push(item);
  }
  if (selection.events) for (const item of events) {
    if (existingEvents.has(item.text)) { skip++; continue; }
    existingEvents.add(item.text); writes.events.push(item); add++;
  }
  if (selection.proposals) for (const item of proposals) {
    if (existingProposals.has(proposalKey(item))) { skip++; continue; }
    existingProposals.add(proposalKey(item)); writes.proposals.push(item); add++;
  }
  if (existingProfile.size > LIMITS.profileEntries || existingEvents.size > LIMITS.events || existingProposals.size > LIMITS.proposals) throw new MemoryLimitError('导入后会超出记忆容量，请减少选择或整理目标范围。');
  const { exportedAt: _, ...snapshot } = current;
  const token = createHash('sha256').update(JSON.stringify([targetScopeId, json, selection, conflict, snapshot])).digest('hex');
  const preview: MemoryImportPreview = { token, source: archive.scope?.label ?? '旧版导出（未标注范围）', exportedAt: archive.exportedAt,
    add, overwrite, skip, conflicts, profile: selection.profile ? profile.length : 0, events: selection.events ? events.length : 0, proposals: selection.proposals ? proposals.length : 0 };
  return { preview, async apply() {
    for (const item of writes.profile) await store.setProfile(item.key, item.value, 'user');
    for (const item of writes.events) await store.addEvent({ text: item.text, tags: item.tags, source: 'user' }, item.at);
    for (const item of writes.proposals) await store.propose({ kind: item.kind, key: item.key, text: item.text, tags: item.tags }, item.at);
  } };
}
