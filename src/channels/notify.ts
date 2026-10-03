/** Push a message to the chat that owns a DSH session, without a user message to reply to. */
export interface ChannelNotifier {
  /** Live delivery metadata, separate from task and approval state. */
  interactionWarning?(sessionId: string): string | undefined;
  /** Resolves `true` when a channel held a route for the session and accepted the text; `false` when no channel knows it. */
  notify(sessionId: string, text: string, deliveryId: string): Promise<boolean>;
}

/** Held instead of sent while the user asked not to be disturbed; the bridge consults this for turns the user did not start. */
export interface PushGate {
  quiet(): boolean;
  hold(sessionId: string, text: string, deliveryId: string): Promise<void>;
}

/** Anything that can route one session to one chat; the DSH bridge implements it. */
export interface SessionNotifier {
  interactionWarning?(sessionId: string): string | undefined;
  notify(sessionId: string, text: string, deliveryId: string): Promise<boolean>;
  /** Sessions this notifier can reach right now. */
  bound(): string[];
  sameChat?(first: string, second: string): boolean;
  /** Submit text into a bound session as if it arrived from outside; `false` when the session is not this notifier's. */
  inject(sessionId: string, text: string, requestId: string): Promise<boolean>;
  setPushGate(gate: PushGate | undefined): void;
  /** Deliver what ended while this notifier was not mounted. */
  catchUp(): Promise<void>;
}

/** Fan-out over the mounted channel bridges; a bridge is removed when its connection closes. */
export class BridgeRegistry implements ChannelNotifier {
  private readonly bridges = new Set<SessionNotifier>();
  private gate?: PushGate;
  private started = false;

  add(bridge: SessionNotifier): void {
    this.bridges.add(bridge);
    bridge.setPushGate(this.gate);
    // A connection turned on after startup catches up at once; at startup the plugin asks once the push gate is in place.
    if (this.started) void bridge.catchUp();
  }

  /** Startup is over: every mounted bridge catches up now, and later mounts catch up as they come. */
  async catchUp(): Promise<void> {
    this.started = true;
    for (const bridge of this.bridges) await bridge.catchUp();
  }

  remove(bridge: SessionNotifier): void { this.bridges.delete(bridge); }

  /** Applies to every mounted bridge, now and later. */
  setPushGate(gate: PushGate | undefined): void {
    this.gate = gate;
    for (const bridge of this.bridges) bridge.setPushGate(gate);
  }

  bound(): string[] { return [...new Set([...this.bridges].flatMap(bridge => bridge.bound()))]; }

  interactionWarning(sessionId: string): string | undefined {
    for (const bridge of this.bridges) { const warning = bridge.interactionWarning?.(sessionId); if (warning) return warning; }
    return undefined;
  }

  sameChat(first: string, second: string): boolean {
    return this.bridges.size > 0 && [...this.bridges].some(bridge => bridge.sameChat?.(first, second) ?? first === second);
  }

  async inject(sessionId: string, text: string, requestId: string): Promise<boolean> {
    for (const bridge of this.bridges) if (await bridge.inject(sessionId, text, requestId)) return true;
    return false;
  }

  async notify(sessionId: string, text: string, deliveryId: string): Promise<boolean> {
    for (const bridge of this.bridges) {
      if (await bridge.notify(sessionId, text, deliveryId)) return true;
    }
    return false;
  }
}
