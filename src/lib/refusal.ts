/**
 * The human half of a refusal (M49.6, K13).
 *
 * Rust refusals lead with their policy code — `projection_disk_changed: …`,
 * `reconciliation_suspended: …` — so the code lands in the operational log
 * and a caller can branch on it. A person needs the sentence, not the code;
 * and before M49.6 the editor showed neither ("Couldn't save page").
 */
export function refusalText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^[a-z]+(?:_[a-z]+)+: /, '');
}
