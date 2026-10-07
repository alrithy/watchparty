"use client";

import { useSyncExternalStore } from "react";
import { useParams } from "next/navigation";
import RoomView from "@/components/RoomView";
import { isValidRoomId } from "@/lib/room/id";
import { getClientId, isHostOf } from "@/lib/room/identity";
import type { Role } from "@/lib/room/types";

const noopSubscribe = () => () => {};

export default function RoomClient() {
  const { id } = useParams<{ id: string }>();
  const roomId = id.toUpperCase();
  // Identity lives in sessionStorage, which only exists in the browser;
  // the server snapshot is empty so the room mounts client-side only.
  const identity = useSyncExternalStore(
    noopSubscribe,
    () => `${getClientId()}|${isHostOf(roomId) ? "host" : "guest"}`,
    () => "",
  );

  if (!isValidRoomId(roomId)) {
    return <p className="p-6 text-red-300">Invalid room code.</p>;
  }
  if (!identity) return <p className="p-6 text-zinc-500">Loading room…</p>;
  const [clientId, role] = identity.split("|") as [string, Role];
  return <RoomView roomId={roomId} clientId={clientId} role={role} />;
}
