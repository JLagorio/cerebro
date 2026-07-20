Single-line text input. Search fields lead with `icon="search"`; keyboard hints go in `suffix`.

```jsx
<Input icon="search" placeholder="Search features…" width={260} />
<Input placeholder="Name your automation" width="100%" />
<Input icon="search" placeholder="Search or ask Cerebro" suffix={<kbd>⌘K</kbd>} />
```

For the global top-bar ask affordance use `AskBar` instead.
