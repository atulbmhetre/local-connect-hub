/**
 * Pure helper — keep in sync with executeOrderInsert message assembly.
 * Truncates the base message first so base + locationNote never exceeds max.
 */
export function composeOrderMessageForRpc(
  text: string,
  locationNote: string,
  maxOrderMessageChars: number,
): string {
  const maxBase = Math.max(0, maxOrderMessageChars - locationNote.length);
  return text.slice(0, maxBase) + locationNote;
}
