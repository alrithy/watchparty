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

/** Internal broadcast carrying a participant's status/drift (see SupabaseTransport). */
const STATUS_EVENT = "participant_status";
type StatusPayload = Pick<PresenceInfo, "clientId" | "status" | "drift">;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

/**
 * Supabase Realtime Broadcast + Presence. Room state lives only in messages, no DB.
 *
 * Supabase rate-limits presence updates hard (about 5 per 30s per client) and
 * closes the channel when that's exceeded, so presence only carries who is in
 * the room. Status and drift change often and travel as broadcasts instead.
 */
class SupabaseTransport implements RoomTransport {
  readonly kind = "supabase" as const;
  private channel: RealtimeChannel | null = null;
  private self: PresenceInfo | null = null;
  private trackedIdentity: string | null = null;
  private members: Pick<PresenceInfo, "clientId" | "role">[] = [];
  private statuses = new Map<string, StatusPayload>();
  private joined = false;
  private closed = false;
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private roomId: string, private handlers: TransportHandlers) {
    this.connect();
  }

  private connect() {
    const supabase = getSupabase()!;
    const channel = supabase.channel(`room:${this.roomId}`, {
      config: { broadcast: { self: false, ack: false }, presence: { key: "" } },
    });
    this.channel = channel;
    this.trackedIdentity = null;
    this.members = [];
    channel
      .on("broadcast", { event: "*" }, ({ event, payload }) => {
        if (event === STATUS_EVENT) {
          const st = payload as StatusPayload;
          this.statuses.set(st.clientId, st);
          this.emitPresence();
        } else {
          this.handlers.onEvent(event as RoomEventName, payload);
        }
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<Pick<PresenceInfo, "clientId" | "role">>();
        const before = new Set(this.members.map((m) => m.clientId));
        this.members = Object.values(state)
          .flat()
          .map(({ clientId, role }) => ({ clientId, role }));
        // Tell newcomers our current status; they missed earlier broadcasts.
        if (this.members.some((m) => !before.has(m.clientId) && m.clientId !== this.self?.clientId)) {
          this.sendStatus();
        }
        this.emitPresence();
      })
      .subscribe((status) => {
        if (channel !== this.channel) return; // a replaced channel
        if (status === "SUBSCRIBED") {
          this.joined = true;
          this.retryMs = RECONNECT_MIN_MS;
          this.trackIdentity();
          this.sendStatus();
          this.handlers.onStatus("connected");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.joined = false;
          if (this.closed) return;
          this.handlers.onStatus("disconnected");
          // The server can close the channel for good (e.g. rate limits), so
          // rebuild it rather than relying on the client's own rejoin.
          this.scheduleReconnect();
        }
      });
    this.handlers.onStatus("connecting");
  }

  private scheduleReconnect() {
    if (this.retryTimer || this.closed) return;
    const old = this.channel;
    this.channel = null;
    if (old) void getSupabase()!.removeChannel(old);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }

  private trackIdentity() {
    if (!this.joined || !this.self || !this.channel) return;
    const identity = `${this.self.clientId}:${this.self.role}`;
    if (identity === this.trackedIdentity) return;
    this.trackedIdentity = identity;
    void this.channel.track({ clientId: this.self.clientId, role: this.self.role });
  }

  private sendStatus() {
    if (!this.joined || !this.self || !this.channel) return;
    const { clientId, status, drift } = this.self;
    void this.channel.send({ type: "broadcast", event: STATUS_EVENT, payload: { clientId, status, drift } });
  }

  private emitPresence() {
    const list = this.members.map((m): PresenceInfo => {
      const st = m.clientId === this.self?.clientId ? this.self : this.statuses.get(m.clientId);
      return { ...m, status: st?.status ?? "idle", drift: st?.drift ?? null };
    });
    this.handlers.onPresence(dedupe(list));
  }

  send<E extends RoomEventName>(event: E, payload: RoomEvents[E]) {
    if (!this.joined || !this.channel) return;
    void this.channel.send({ type: "broadcast", event, payload });
  }

  track(info: PresenceInfo) {
    this.self = info;
    this.trackIdentity();
    this.sendStatus();
    this.emitPresence();
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.channel) void getSupabase()!.removeChannel(this.channel);
    this.channel = null;
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
