export type ImageSource = 'vault' | 'data' | 'remote' | 'insecure' | 'refused';

/** Classify before any browser element sees a source. Controls and backslashes
 * refuse instead of relying on the browser's URL repair rules. */
export function imageSource(input: string): ImageSource {
  const value = input.trim();
  if (
    !value ||
    value.includes('\\') ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return 'refused';
  if (/^https:\/\//i.test(value)) return 'remote';
  if (/^(?:http:|\/\/)/i.test(value)) return 'insecure';
  if (/^data:/i.test(value)) return 'data';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'refused';
  return 'vault';
}
