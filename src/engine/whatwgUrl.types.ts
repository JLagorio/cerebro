/** The pure parser's public record fields this engine reads. No DOM API or
 * global constructor is imported into the no-DOM engine compilation. */
declare module 'whatwg-url' {
  export function parseURL(input: string): {
    scheme: string;
    username: string;
    password: string;
    host: string | number | number[] | null;
  } | null;
}
