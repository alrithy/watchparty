"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { generateRoomId, normalizeRoomId } from "@/lib/room/id";
import { claimHost } from "@/lib/room/identity";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    const id = generateRoomId();
    claimHost(id);
    router.push(`/room/${id}`);
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const id = normalizeRoomId(code);
    if (!id) {
      setError("That doesn't look like a room code or invite link.");
      return;
    }
    router.push(`/room/${id}`);
  };

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-wide text-zinc-100">Watch Party</h1>
          <p className="mt-2 text-sm text-zinc-400">Private synchronized playback.</p>
        </div>
        <button
          data-testid="create-room"
          onClick={create}
          className="w-full rounded-md bg-zinc-100 py-3 font-medium text-zinc-900 hover:bg-white"
        >
          Create Room
        </button>
        <form onSubmit={join} className="space-y-2">
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Room code or invite link"
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-400"
            />
            <button className="rounded-md border border-zinc-600 px-4 py-2 text-zinc-100 hover:border-zinc-300">
              Join Room
            </button>
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
        </form>
      </div>
    </main>
  );
}
