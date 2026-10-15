/** Scene commands receive ids from their host; randomness never enters the core. */
export function newBoardId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
