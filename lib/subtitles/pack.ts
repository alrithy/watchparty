/**
 * Subtitles travel to guests inside room messages, so the text is deflated
 * (native CompressionStream) and base64-encoded: a 2-hour SRT is ~25 KB.
 */
export const MAX_PACKED_BYTES = 200_000;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function packText(text: string): Promise<string> {
  const bytes = await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function unpackText(packed: string): Promise<string> {
  const bin = atob(packed);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
}
