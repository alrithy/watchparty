import { Suspense } from "react";
import RoomClient from "@/components/RoomClient";

export default function RoomPage() {
  return (
    <Suspense fallback={<p className="p-6 text-zinc-500">Loading room…</p>}>
      <RoomClient />
    </Suspense>
  );
}
