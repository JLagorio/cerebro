Modal for create/edit flows ("Create scheduled automation"). Scrim closes on click; footer = note left, Cancel + primary right.

```jsx
<Dialog open={open} onClose={close} title="Create scheduled automation" width={640}
  footerNote="Automations may run with a small delay."
  secondaryAction={{label:"Cancel",onClick:close}}
  primaryAction={{label:"Create",onClick:create}}>
  …form fields…
</Dialog>
```
