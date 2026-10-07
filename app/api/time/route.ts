import { connection } from "next/server";

// Reference clock for all participants. Must never be cached.
export async function GET() {
  await connection();
  return Response.json(
    { now: Date.now() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
