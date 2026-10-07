import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The anon key is designed to be public; it only grants Realtime channel access here.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null | undefined;

/** Returns null when Supabase isn't configured (local two-tab mode). */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  client =
    url && anonKey
      ? createClient(url, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: {
            params: { eventsPerSecond: 20 },
            // Default is 25s; a dead socket is only noticed after a missed beat,
            // so a shorter interval lets a dropped guest reconnect within seconds.
            heartbeatIntervalMs: 5000,
          },
        })
      : null;
  return client;
}

export const isSupabaseConfigured = Boolean(url && anonKey);
