import type { RealtimeChannel } from "@supabase/supabase-js";
import type { PresenceInfo, RoomEventName, RoomEvents } from "@/lib/room/types";
import { getSupabase } from "@/lib/realtime/supabase";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type TransportHandlers = {
  onEvent: <E extends RoomEventName>(event: E, payload: RoomEvents[E]) => void;
  onPresence: (participants: PresenceInfo[]) => void;
  /** Fires with "connected" on every (re)join, so callers can resync. */
  onStatus: (status: ConnectionStatus) => void;
};

export interface RoomTransport {
  readonly kind: "supabase" | "local";
  send<E extends RoomEventName>(event: E, payload: RoomEvents[E]): void;
  track(info: PresenceInfo): void;
  close(): void;
}

export function createTransport(roomId: string, handlers: TransportHandlers): RoomTransport {
  const supabase = getSupabase();
  return supabase
    ? new SupabaseTransport(roomId, handlers)
    : new LocalTransport(roomId, handlers);
}

/** Supabase Realtime Broadcast + Presence. Room state lives only in messages, no DB. */
class SupabaseTransport implements RoomTransport {
  readonly kind = "supabase" as const;
  private channel: RealtimeChannel;
  private presence: PresenceInfo | null = null;
  private joined = false;

  constructor(roomId: string, private handlers: TransportHandlers) {
    const supabase = getSupabase()!;
    this.channel = supabase.channel(`room:${roomId}`, {
      config: { broadcast: { self: false, ack: false }, presence: { key: "" } },
    });
    this.channel
      .on("broadcast", { event: "*" }, ({ event, payload }) => {
        handlers.onEvent(event as RoomEventName, payload);
      })
      .on("presence", { event: "sync" }, () => {
        const state = this.channel.presenceState<PresenceInfo>();
        handlers.onPresence(dedupe(Object.values(state).flat()));
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.joined = true;
          if (this.presence) void this.channel.track(this.presence);
          handlers.onStatus("connected");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.joined = false;
          handlers.onStatus("disconnected");
        }
      });
    handlers.onStatus("connecting");
  }

  send<E extends RoomEventName>(event: E, payload: RoomEvents[E]) {
    if (!this.joined) return;
    void this.channel.send({ type: "broadcast", event, payload });
  }

  track(info: PresenceInfo) {
    this.presence = info;
    if (this.joined) void this.channel.track(info);
  }

  close() {
    void this.channel.unsubscribe();
  }
}

/**
 * Same-browser fallback used when Supabase env vars are missing, so the app
 * can be developed and tested in two tabs without a Supabase project.
 */
class LocalTransport implements RoomTransport {
  readonly kind = "local" as const;
  private bc: BroadcastChannel;
  private peers = new Map<string, { info: PresenceInfo; seen: number }>();
  private self: PresenceInfo | null = null;
  private timer: ReturnType<typeof setInterval>;

  constructor(roomId: string, private handlers: TransportHandlers) {
    this.bc = new BroadcastChannel(`watchparty:${roomId}`);
    this.bc.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { kind: "event"; event: RoomEventName; payload: never }
        | { kind: "presence"; info: PresenceInfo }
        | { kind: "leave"; clientId: string };
      if (msg.kind === "event") handlers.onEvent(msg.event, msg.payload);
      else if (msg.kind === "presence") {
        const isNew = !this.peers.has(msg.info.clientId);
        this.peers.set(msg.info.clientId, { info: msg.info, seen: Date.now() });
        // Answer newcomers right away so they don't wait a heartbeat.
        if (isNew) this.announce();
        this.emitPresence();
      } else if (msg.kind === "leave") {
        this.peers.delete(msg.clientId);
        this.emitPresence();
      }
    };
    this.timer = setInterval(() => {
      this.announce();
      const cutoff = Date.now() - 5000;
      for (const [id, p] of this.peers) if (p.seen < cutoff) this.peers.delete(id);
      this.emitPresence();
    }, 2000);
    window.addEventListener("pagehide", this.leave);
    queueMicrotask(() => handlers.onStatus("connected"));
  }

  private leave = () => {
    if (this.self) this.bc.postMessage({ kind: "leave", clientId: this.self.clientId });
  };

  private announce() {
    if (this.self) this.bc.postMessage({ kind: "presence", info: this.self });
  }

  private emitPresence() {
    const list = [...this.peers.values()].map((p) => p.info);
    if (this.self) list.push(this.self);
    this.handlers.onPresence(dedupe(list));
  }

  send<E extends RoomEventName>(event: E, payload: RoomEvents[E]) {
    this.bc.postMessage({ kind: "event", event, payload });
  }

  track(info: PresenceInfo) {
    this.self = info;
    this.announce();
    this.emitPresence();
  }

  close() {
    this.leave();
    clearInterval(this.timer);
    window.removeEventListener("pagehide", this.leave);
    this.bc.close();
  }
}

function dedupe(list: PresenceInfo[]): PresenceInfo[] {
  const byId = new Map<string, PresenceInfo>();
  for (const p of list) byId.set(p.clientId, p);
  return [...byId.values()].sort((a, b) =>
    a.role === b.role ? a.clientId.localeCompare(b.clientId) : a.role === "host" ? -1 : 1,
  );
}
