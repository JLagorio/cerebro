# Avatar

An initials disc on a ground picked from the person's name; `AvatarGroup` overlaps several and ends in +N.

- Use it wherever a person shows: property chips, people fields, conversation turns. A person keeps one colour everywhere because the ground is a hash of `name`.
- The consumer provides `name` (full name; initials are the first letters of the first two words, upper-cased). `size` is in px, default 24: 18–20 in table rows and chips, 28 in headers and the assistant transcript.
- Ground: one of `avatar-1` … `avatar-8`, the swatch hues darkened so white initials clear 4.5:1. Initials are `text-inverse`, `font-ui` weight 700, 0.02em tracking, at 42% of the size and never under 10px.
- `src` draws a picture instead, cover-cropped in the same circle, only for a vault path or a `data:` URI. Any other source (a web URL included) keeps the initials and loads nothing.
- The disc carries the full name as its `title` (and `alt` on a picture). `style` and `className` pass through.
- `AvatarGroup` takes `names`, `size` (default 24) and `max` (default 3). Discs overlap by 30% of the size, each ringed 2px in `n-0`; the remainder is an `n-100` disc with `n-700` "+N" at 40% (floor 10px).
- Don't: a raw hex ground, or initials under 10px.
