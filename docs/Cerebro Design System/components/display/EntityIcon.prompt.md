The canonical entity glyph — always pair an entity name with its EntityIcon. Features render as filled rounded squares, subfeatures as dots (both accept a user `swatch`); everything else is a colored lucide glyph (objective target, keyResult trending-up, initiative diamond, release flag, …).

```jsx
<EntityIcon type="objective" />
<EntityIcon type="feature" swatch="var(--swatch-amber)" />
<EntityIcon type="keyResult" size={14} />
```
