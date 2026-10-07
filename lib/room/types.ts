export type PlaybackMode = "direct" | "host-rd";

/** What the room is watching. Never contains credentials. */
export type MediaSource = {
  mode: PlaybackMode;
  /** Browser-playable URL. */
  url: string;
  /** Short display name (file name or host). */
  label: string;
};

/** Authoritative playback state, owned by the host in V1. */
export type PlaybackState = {
  playing: boolean;
  /** Media position at `refTime`. */
  positionSeconds: number;
  /** Server-clock timestamp (ms) at which `positionSeconds` was true. */
  refTime: number;
  /** Monotonic across host reloads (derived from server time). */
  revision: number;
  hostId: string;
};

export type RoomSettings = {
  pauseOnBuffer: boolean;
};

export type RoomSnapshot = {
  media: MediaSource | null;
  state: PlaybackState | null;
  settings: RoomSettings;
};

export type Role = "host" | "guest";

export type ParticipantStatus = "idle" | "loading" | "ready" | "buffering" | "error";

export type PresenceInfo = {
  clientId: string;
  role: Role;
  status: ParticipantStatus;
  /** Guest's last measured drift in seconds (positive = ahead). */
  drift: number | null;
};

export type RoomEvents = {
  state: PlaybackState;
  snapshot: RoomSnapshot;
  snapshot_request: { from: string };
};

export type RoomEventName = keyof RoomEvents;
