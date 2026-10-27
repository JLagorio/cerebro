/** Unicode scalar order matches Rust string/UTF-8 order for valid filenames.
 * JavaScript's default UTF-16 comparison orders astral characters differently. */
export function compareUnicodeScalars(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const first = left.codePointAt(a)!;
    const second = right.codePointAt(b)!;
    if (first !== second) return first < second ? -1 : 1;
    a += first > 0xffff ? 2 : 1;
    b += second > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}
