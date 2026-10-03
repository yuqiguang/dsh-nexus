import { reviewPolicy, type CoderReviewPolicy } from './review-policy.js';
import { isAbsolute, resolve } from 'node:path';
import type { Records } from '../channels/records.js';
import { ChannelError } from '../channels/types.js';
import type { CoderKind } from './types.js';
import { isManagedVersion } from './install-shared.js';

/** Where a coder's binaries come from: the copy Nexus installs itself, or whatever the machine already has. */
export type CoderSecurityMode = 'standard' | 'strict' | 'full';
export type CoderSource = 'managed' | 'system';
export type ClaudeAuthHeader = 'auth-token' | 'api-key';
export type CodexWireApi = 'responses' | 'chat';

export interface CodexSettings {
  source: CoderSource;
  /** Empty/absent follows the plugin recommendation; an exact version pins future installs only. */
  managedVersion?: string;
  model?: string;
  /** Compatible endpoint; empty means the official OpenAI API. Applies to the managed install only. */
  baseUrl?: string;
  wireApi?: CodexWireApi;
  /** Secret; empty means not configured. */
  apiKey: string;
}

export interface ClaudeSettings {
  source: CoderSource;
  /** Empty/absent follows the plugin recommendation; an exact version pins future installs only. */
  managedVersion?: string;
  model?: string;
  /** Compatible endpoint; empty means the official Anthropic API. */
  baseUrl?: string;
  authHeader: ClaudeAuthHeader;
  /** Secret; empty means not configured. */
  token: string;
}

/** One record in native credentials: coder preferences and their secrets, saved atomically with a revision. */
export interface CoderSettingsRecord {
  version: 1;
  revision: number;
  defaultCoder: CoderKind;
  /** Overrides the profile's coderRoots when non-empty. */
  roots?: string[];
  /** Legacy project picker value, preserved on disk but no longer used. */
  projectRoot?: string;
  maxTaskMinutes?: number;
  maxConcurrent?: number;
  autoApproveSafe?: boolean;
  securityMode?: CoderSecurityMode;
  reviewPolicy?: CoderReviewPolicy;
  allowedNetworkDomains?: string[];
  codex: CodexSettings;
  claude: ClaudeSettings;
}

export interface CoderSettingsInput {
  defaultCoder?: unknown;
  roots?: unknown;
  maxTaskMinutes?: unknown;
  maxConcurrent?: unknown;
  autoApproveSafe?: unknown;
  securityMode?: unknown;
  reviewPolicy?: unknown;
  allowedNetworkDomains?: unknown;
  codex?: unknown;
  claude?: unknown;
}

export const DEFAULT_NETWORK_DOMAINS = ['registry.npmjs.org'];
export function networkDomains(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_NETWORK_DOMAINS];
  const values = typeof value === 'string' ? value.split('\n') : value;
  if (!Array.isArray(values) || values.length > 32) throw new ChannelError('invalid_configuration');
  return [...new Set(values.map(item => {
    if (typeof item !== 'string') throw new ChannelError('invalid_configuration');
    const domain = item.trim().toLowerCase();
    if (domain && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(domain)) throw new ChannelError('invalid_configuration');
    return domain;
  }).filter(Boolean))];
}

export function taskMinutes(value: unknown): number {
  if (value === undefined) return 60;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 240) throw new ChannelError('invalid_configuration');
  return value;
}

export const DEFAULT_CODER_CONCURRENCY = 2;
export function coderConcurrency(value: unknown): number {
  if (value === undefined) return DEFAULT_CODER_CONCURRENCY;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4) throw new ChannelError('invalid_configuration');
  return value;
}

export const SETTINGS_KEY = 'coders';
const SOURCES: readonly CoderSource[] = ['managed', 'system'];
const HEADERS: readonly ClaudeAuthHeader[] = ['auth-token', 'api-key'];
const WIRE_APIS: readonly CodexWireApi[] = ['responses', 'chat'];

export function defaultSettings(): CoderSettingsRecord {
  return { version: 1, revision: 0, defaultCoder: 'codex', maxConcurrent: DEFAULT_CODER_CONCURRENCY,
    codex: { source: 'managed', apiKey: '' }, claude: { source: 'managed', authHeader: 'auth-token', token: '' } };
}

function text(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > max) throw new ChannelError('invalid_configuration');
  return value.trim();
}

function optional(value: unknown, max: number): string | undefined {
  const trimmed = text(value, max);
  return trimmed ? trimmed : undefined;
}

function managedVersion(value: unknown): { managedVersion?: string } {
  if (value === undefined || value === '') return {};
  if (!isManagedVersion(value)) throw new ChannelError('invalid_managed_version');
  return { managedVersion: value };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value as T)) throw new ChannelError('invalid_configuration');
  return value as T;
}

export function endpointUrl(value: unknown): string | undefined {
  const raw = optional(value, 512);
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new ChannelError('invalid_endpoint'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) throw new ChannelError('invalid_endpoint');
  return url.href.replace(/\/+$/, '');
}

/** Roots come one per line or as an array; each must be an absolute path. Empty means "follow the native session workspace". */
export function rootsInput(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : value === undefined || value === null ? [] : undefined;
  if (!items) throw new ChannelError('invalid_configuration');
  const roots = [...new Set(items.map(item => text(item, 1024)).filter(Boolean).map(item => {
    if (!isAbsolute(item)) throw new ChannelError('invalid_root');
    return resolve(item);
  }))];
  if (roots.length > 32) throw new ChannelError('invalid_configuration');
  return roots.length ? roots : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ChannelError('invalid_configuration');
  return value as Record<string, unknown>;
}

function decode(raw: unknown): CoderSettingsRecord | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new ChannelError('invalid_saved_record');
  const value = raw as CoderSettingsRecord;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['codex', 'claude'].includes(value.defaultCoder)
    || !value.codex || !value.claude || typeof value.codex.apiKey !== 'string' || typeof value.claude.token !== 'string'
    || !SOURCES.includes(value.codex.source) || !SOURCES.includes(value.claude.source) || !HEADERS.includes(value.claude.authHeader)
    || (value.roots !== undefined && (!Array.isArray(value.roots) || !value.roots.every(root => typeof root === 'string')))) {
    throw new ChannelError('invalid_saved_record');
  }
  for (const coder of ['codex', 'claude'] as const) {
    if (value[coder].managedVersion !== undefined && !isManagedVersion(value[coder].managedVersion)) throw new ChannelError('invalid_saved_record');
  }
  if (value.securityMode !== undefined && !['standard', 'strict', 'full'].includes(value.securityMode)) throw new ChannelError('invalid_saved_record');
  if (value.reviewPolicy !== undefined) reviewPolicy(value.reviewPolicy);
  if (value.projectRoot !== undefined && (typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot))) throw new ChannelError('invalid_saved_record');
  if (value.allowedNetworkDomains !== undefined) networkDomains(value.allowedNetworkDomains);
  if (value.autoApproveSafe !== undefined && typeof value.autoApproveSafe !== 'boolean') throw new ChannelError('invalid_saved_record');
  if (value.maxTaskMinutes !== undefined) taskMinutes(value.maxTaskMinutes);
  if (value.maxConcurrent !== undefined) coderConcurrency(value.maxConcurrent);
  return structuredClone(value);
}

/** What the settings page may see: everything except the secrets themselves. */
export interface CoderSettingsView {
  revision: number;
  defaultCoder: CoderKind;
  roots?: string[];
  maxTaskMinutes?: number;
  maxConcurrent?: number;
  autoApproveSafe?: boolean;
  securityMode?: CoderSecurityMode;
  reviewPolicy?: CoderReviewPolicy;
  allowedNetworkDomains?: string[];
  codex: Omit<CodexSettings, 'apiKey'> & { apiKeyConfigured: boolean };
  claude: Omit<ClaudeSettings, 'token'> & { tokenConfigured: boolean };
}

export function redact(settings: CoderSettingsRecord): CoderSettingsView {
  const { apiKey, ...codex } = settings.codex;
  const { token, ...claude } = settings.claude;
  return { reviewPolicy: reviewPolicy(settings.reviewPolicy), securityMode: settings.securityMode ?? 'standard', revision: settings.revision, defaultCoder: settings.defaultCoder, maxTaskMinutes: settings.maxTaskMinutes ?? 60, maxConcurrent: coderConcurrency(settings.maxConcurrent), autoApproveSafe: settings.autoApproveSafe ?? true, allowedNetworkDomains: networkDomains(settings.allowedNetworkDomains), ...(settings.roots ? { roots: [...settings.roots] } : {}),
    codex: { ...codex, apiKeyConfigured: apiKey.length > 0 }, claude: { ...claude, tokenConfigured: token.length > 0 } };
}

/** Coder preferences and secrets in native credentials; revision-checked like the channel connections. */
export class CoderSettingsStore {
  constructor(private readonly records: Records) {}

  async read(): Promise<CoderSettingsRecord> {
    return decode(await this.records.read(SETTINGS_KEY)) ?? defaultSettings();
  }

  /** An empty secret keeps the stored one; other fields are replaced by the submitted values. */
  async save(expectedRevision: number, input: CoderSettingsInput): Promise<CoderSettingsRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ChannelError('invalid_revision');
    if (input.autoApproveSafe !== undefined && typeof input.autoApproveSafe !== 'boolean') throw new ChannelError('invalid_configuration');
    const codexInput = record(input.codex);
    const claudeInput = record(input.claude);
    const next = (previous: CoderSettingsRecord): CoderSettingsRecord => ({
      version: 1, revision: previous.revision + 1, reviewPolicy: reviewPolicy(input.reviewPolicy === undefined ? previous.reviewPolicy : input.reviewPolicy), securityMode: oneOf(input.securityMode, ['standard', 'strict', 'full'] as const, previous.securityMode ?? 'standard'), autoApproveSafe: (input.autoApproveSafe as boolean | undefined) ?? previous.autoApproveSafe ?? true, maxTaskMinutes: taskMinutes(input.maxTaskMinutes ?? previous.maxTaskMinutes), allowedNetworkDomains: networkDomains(input.allowedNetworkDomains ?? previous.allowedNetworkDomains),
      defaultCoder: oneOf(input.defaultCoder, ['codex', 'claude'] as const, previous.defaultCoder),
      ...(previous.projectRoot ? { projectRoot: previous.projectRoot } : {}),
      maxConcurrent: coderConcurrency(input.maxConcurrent === undefined ? previous.maxConcurrent : input.maxConcurrent),
      ...(rootsInput(input.roots) ? { roots: rootsInput(input.roots) } : {}),
      codex: {
        source: oneOf(codexInput.source, SOURCES, previous.codex.source),
        ...managedVersion(codexInput.managedVersion === undefined ? previous.codex.managedVersion : codexInput.managedVersion),
        ...(optional(codexInput.model, 128) ? { model: optional(codexInput.model, 128) } : {}),
        ...(endpointUrl(codexInput.baseUrl) ? { baseUrl: endpointUrl(codexInput.baseUrl) } : {}),
        ...(optional(codexInput.wireApi, 16) ? { wireApi: oneOf(codexInput.wireApi, WIRE_APIS, 'responses') } : {}),
        apiKey: text(codexInput.apiKey, 4096) || previous.codex.apiKey,
      },
      claude: {
        source: oneOf(claudeInput.source, SOURCES, previous.claude.source),
        ...managedVersion(claudeInput.managedVersion === undefined ? previous.claude.managedVersion : claudeInput.managedVersion),
        ...(optional(claudeInput.model, 128) ? { model: optional(claudeInput.model, 128) } : {}),
        ...(endpointUrl(claudeInput.baseUrl) ? { baseUrl: endpointUrl(claudeInput.baseUrl) } : {}),
        authHeader: oneOf(claudeInput.authHeader, HEADERS, previous.claude.authHeader),
        token: text(claudeInput.token, 4096) || previous.claude.token,
      },
    });
    const result = await this.records.modify(SETTINGS_KEY, async current => {
      const previous = decode(current) ?? defaultSettings();
      if (previous.revision !== expectedRevision) throw new ChannelError('configuration_changed');
      return next(previous);
    });
    return decode(result)!;
  }

  /** Forget one secret without touching anything else; the revision still advances. */
  async clearSecret(expectedRevision: number, coder: CoderKind): Promise<CoderSettingsRecord> {
    const result = await this.records.modify(SETTINGS_KEY, async current => {
      const previous = decode(current) ?? defaultSettings();
      if (previous.revision !== expectedRevision) throw new ChannelError('configuration_changed');
      return coder === 'codex' ? { ...previous, revision: previous.revision + 1, codex: { ...previous.codex, apiKey: '' } }
        : { ...previous, revision: previous.revision + 1, claude: { ...previous.claude, token: '' } };
    });
    return decode(result)!;
  }
}
