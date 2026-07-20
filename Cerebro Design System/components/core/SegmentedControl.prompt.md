Segmented control for exclusive small sets: board layout (Grid / Timeline / Columns), schedule frequency, scope.

```jsx
<SegmentedControl value={layout} onChange={setLayout} options={[
  {value:"grid",label:"Grid",icon:"table-2"},
  {value:"timeline",label:"Timeline",icon:"calendar-range"},
  {value:"columns",label:"Columns",icon:"kanban"}]} />
```
