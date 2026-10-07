// No 0/O/1/I/L to keep codes easy to read aloud.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 6;

export function generateRoomId(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeRoomId(input: string): string | null {
  const trimmed = input.trim();
  // Accept a pasted invite link as well as a bare code.
  const match = trimmed.match(/room\/([A-Za-z0-9]+)/);
  const code = (match ? match[1] : trimmed).toUpperCase();
  return isValidRoomId(code) ? code : null;
}

export function isValidRoomId(id: string): boolean {
  return id.length === LENGTH && [...id].every((c) => ALPHABET.includes(c));
}

export function randomId(): string {
  return crypto.randomUUID();
}
