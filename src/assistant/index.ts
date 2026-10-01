import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { BridgeRegistry, ChannelNotifier } from '../channels/notify.js';
import { identity } from '../channels/protocol.js';
import { ChannelError } from '../channels/types.js';
import { DshRecords } from '../dsh/records.js';
import { DailyBriefing, type AgendaSource } from './briefing.js';
import { formatLocal } from './clock.js';
import { HOOK_PATH, HookError, frameHookEvent, parseHookRequest, respond } from './hook.js';
import { DEFAULT_PERSONA, installPersona } from './persona.js';
import { PushGate } from './pushes.js';
import { AssistantSettingsStore, redactAssistant, type AssistantSettingsRecord, type AssistantSettingsView } from './settings.js';
import { speechConfigured } from './speech.js';
import { DEFAULT_ROTATION, type RotationSettings } from '../sessions/index.js';
import { transcribeWav } from './transcribe.js';

export interface AssistantView {
  settings: AssistantSettingsView;
  /** Local time in the configured zone, so the page can show what "now" means. */
  localTime: string;
  quietNow: boolean;
  heldPushes: number;
  nextBriefingAt?: number;
  /** Absolute hook URL when the web server is up and the hook is enabled. */
  hookUrl?: string;
  /** Only present in the response to the rotation that minted it. */
  hookToken?: string;
}

export interface AssistantDeps {
  ctx: Context;
  registry: BridgeRegistry;
  now?: () => number;
  /** Where background failures (held-push flush, briefing, hook) are reported; defaults to the service log. */
  report?: (message: string) => void;
  /** Test seam for the speech service. */
  fetchImpl?: typeof fetch;
}

/** Assistant preferences and the behaviours they drive: the persona in the system prompt, quiet hours, the daily briefing, and the inbound hook. */
export class Assistant {
  private settings!: AssistantSettingsRecord;
  private gate!: PushGate;
  private briefing!: DailyBriefing;
  private readonly store: AssistantSettingsStore;
  private readonly now: () => number;

  constructor(private readonly deps: AssistantDeps) {
    this.store = new AssistantSettingsStore(new DshRecords(deps.ctx.credentials, 'nexus-assistant'));
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    const { ctx, registry } = this.deps;
    const report = this.deps.report ?? ((message: string) => console.error(`[nexus-assistant] ${message}`));
    this.settings = await this.store.read();
    installPersona(ctx, () => this.settings.persona ?? DEFAULT_PERSONA);
    this.gate = await PushGate.open(ctx.storageDomain, registry, this.settings, this.now, report);
    registry.setPushGate(this.gate);
    this.briefing = new DailyBriefing({ ctx, notifier: this.gate, sessions: () => registry.bound(), sameChat: (a, b) => registry.sameChat(a, b), now: this.now, onError: report }, this.settings);
    ctx.effect(() => () => { registry.setPushGate(undefined); this.briefing.close(); void this.gate.close(); });
    // Whatever was held while the process was down goes out now if the window has passed.
    if (!this.gate.quiet()) void this.gate.flush().catch(error => report(`startup flush failed: ${(error as Error)?.message ?? error}`));
    // Web and current Desktop provide an HTTP listener; shared-Fetch-only hosts can omit it.
    ctx.inject(['webServer'], hostCtx => {
      hostCtx.effect(() => hostCtx.webServer.register({ kind: 'exact', path: HOOK_PATH, handler: (request, response) => this.handleHook(request, response) }));
    });
  }

  private async handleHook(request: Parameters<typeof parseHookRequest>[0], response: Parameters<typeof respond>[0]): Promise<void> {
    try {
      const event = await parseHookRequest(request, () => this.settings.hookToken);
      const sessions = this.deps.registry.bound();
      if (!sessions.length) throw new HookError(503, 'no channel is bound');
      const requestId = identity('hook', String(this.now()), event.source, event.text);
      let accepted = 0;
      for (const sessionId of sessions) if (await this.deps.registry.inject(sessionId, frameHookEvent(event), requestId)) accepted++;
      respond(response, 202, { accepted });
    } catch (error) {
      if (error instanceof HookError) { respond(response, error.status, { error: error.message }); return; }
      (this.deps.report ?? console.error)(`hook failed: ${(error as Error)?.message ?? error}`);
      respond(response, 500, { error: 'internal' });
    }
  }

  /** The user's time zone, for notices other modules write. */
  timeZone(): string { return this.settings.timeZone; }

  /** When channel sessions are replaced by fresh ones. */
  rotation(): RotationSettings { return this.settings.rotation ?? DEFAULT_ROTATION; }

  /** Proactive pushes from other modules go through the quiet-hours gate. */
  notifier(): ChannelNotifier { return this.gate; }

  /** Turn a WAV clip into text with the configured service; `speech_not_configured` when there is none. */
  async transcribe(wav: Buffer, signal: AbortSignal): Promise<string> {
    if (!speechConfigured(this.settings.speech)) throw new ChannelError('speech_not_configured');
    return transcribeWav(this.settings.speech, wav, signal, this.deps.fetchImpl);
  }

  /** The briefing includes the agenda once a connector provides it. */
  attachAgenda(source: AgendaSource): void { this.briefing.attachAgenda(source); }

  heldPushes(): number { return this.gate.pending().length; }

  view(extra: Partial<AssistantView> = {}): AssistantView {
    const origin = this.deps.ctx.get('webServer') ? `http://127.0.0.1:${(this.deps.ctx.get('webServer') as { port?: number }).port ?? ''}` : undefined;
    const nextBriefingAt = this.briefing.nextAt();
    return { settings: redactAssistant(this.settings), localTime: formatLocal(this.now(), this.settings.timeZone), quietNow: this.gate.quiet(),
      heldPushes: this.gate.pending().length, ...(nextBriefingAt !== undefined ? { nextBriefingAt } : {}),
      ...(this.settings.hookToken && origin ? { hookUrl: `${origin}${HOOK_PATH}` } : {}), ...extra };
  }

  private apply(settings: AssistantSettingsRecord): void {
    this.settings = settings;
    this.gate.update(settings);
    this.briefing.update(settings);
  }

  async handle(method: string, payload: unknown): Promise<AssistantView> {
    if (method === 'list') return this.view();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    if (method === 'save') { this.apply(await this.store.save(input.revision as number, (input.config ?? {}) as Record<string, unknown>)); return this.view(); }
    if (method === 'hook/rotate') {
      this.apply(await this.store.rotateHook(input.revision as number, input.enabled !== false));
      return this.view(this.settings.hookToken ? { hookToken: this.settings.hookToken } : {});
    }
    if (method === 'speech/clear') { this.apply(await this.store.clearSpeech(input.revision as number)); return this.view(); }
    if (method === 'briefing/send') { await this.briefing.send(true); return this.view(); }
    if (method === 'flush') { await this.gate.flush(); return this.view(); }
    throw new ChannelError('unknown_action');
  }
}
