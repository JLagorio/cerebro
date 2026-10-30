# Switch

A 32×18 toggle for a setting that takes effect the moment it flips.

- Use it for view and layout settings that apply at once ("Show weekends", "Color columns"). A choice that waits for Save, or one of three states, is a checkbox or a `SegmentedControl`.
- The consumer provides `checked` and `onChange(checked)`; `label` is any node, drawn at `fs-sm` 13px with an 8px gap after the track.
- Without a visible label (a property row that names it elsewhere) pass `ariaLabel`, which names the inner `role="switch"` checkbox.
- Track: 32×18, `r-full`, `n-300` off and `accent` (`cortex-500`) on, colour on `motion-hover`.
- Knob: 14px white circle with `shadow-xs`, 2px inset, travelling 14px on `motion-spring` (reduced motion stills it).
- Focus draws `ring` on the track. `disabled` is 45% opacity with a not-allowed cursor, label included.
- The whole label is the hit target. `style` and `className` pass through.
