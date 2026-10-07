import { randomId } from "@/lib/room/id";

// sessionStorage is per tab and survives reloads: a reloaded host stays host,
// while the invite link opened in another tab joins as a guest.
const CLIENT_KEY = "watchparty:client";
const hostKey = (roomId: string) => `watchparty:host:${roomId}`;

export function getClientId(): string {
  let id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = randomId();
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

export function claimHost(roomId: string) {
  sessionStorage.setItem(hostKey(roomId), "1");
}

export function isHostOf(roomId: string): boolean {
  return sessionStorage.getItem(hostKey(roomId)) === "1";
}
