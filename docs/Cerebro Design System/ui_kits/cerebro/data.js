export const PEOPLE = ["Maya Chen", "Josef Lang", "Ana Rios", "Sam Ito", "Priya Nair", "Mo Byrd"];

export const OBJECTIVES = [
  { id: "obj-1", name: "Increase Field App adoption", timeframe: "2026", owner: "Maya Chen", health: "on", progress: 40, team: "Field Platform",
    description: "Field technicians default to email and phone because the app's first-run experience stalls them. This objective tracks making Field App the daily tool of record.",
    krs: [
      { id: "kr-11", name: "5,000 weekly active technicians", timeframe: "Q3, 2026 – Q4, 2026", owner: "Ana Rios", health: "on", progress: 62, current: "3,100 / 5,000" },
      { id: "kr-12", name: "First setup under 10 minutes", timeframe: "Q3, 2026 – Q4, 2026", owner: "Sam Ito", health: "risk", progress: 35, current: "18 min median" },
    ] },
  { id: "obj-2", name: "Consolidate tooling onto Console", timeframe: "2026", owner: "Josef Lang", health: "risk", progress: 25, team: "Internal Systems",
    description: "Twelve legacy tools still hold workflows hostage. Consolidation cuts license spend and puts every service request behind one queue.",
    krs: [
      { id: "kr-21", name: "Migrate 12 legacy tools", timeframe: "2026", owner: "Josef Lang", health: "risk", progress: 42, current: "5 / 12 migrated" },
      { id: "kr-22", name: "95% of service requests via Console", timeframe: "Q4, 2026", owner: "Mo Byrd", health: "on", progress: 55, current: "71% today" },
    ] },
  { id: "obj-3", name: "Raise knowledge reuse across teams", timeframe: "H2 2026", owner: "Priya Nair", health: "on", progress: 55, team: "Knowledge",
    description: "Answers exist but don't travel. Cerebro should make the second ask of any question instant.",
    krs: [
      { id: "kr-31", name: "80% of specs cite at least one signal", timeframe: "Q3, 2026 – Q4, 2026", owner: "Priya Nair", health: "on", progress: 71, current: "64% today" },
      { id: "kr-32", name: "Median answer time under 2 minutes", timeframe: "Q4, 2026", owner: "Mo Byrd", health: "none", progress: 0, current: "Not started" },
    ] },
];

export const INITIATIVES = [
  { id: "init-1", name: "Guided mobile onboarding", status: "progress", owner: "Ana Rios", objective: "Increase Field App adoption", progress: 40, timeframe: "Jun 2026 → Oct 2026", swatch: "var(--swatch-teal)", start: 5, len: 4,
    features: [
      { id: "ft-11", name: "Setup checklist", swatch: "var(--swatch-teal)", status: "released", start: 5, len: 2, release: "Field App 4.2", owner: "Ana Rios" },
      { id: "ft-12", name: "Offline-first sync", swatch: "var(--swatch-blue)", status: "progress", start: 6, len: 3, release: "Field App 4.3", owner: "Sam Ito" },
    ] },
  { id: "init-2", name: "Single sign-on everywhere", status: "progress", owner: "Sam Ito", objective: "Consolidate tooling onto Console", progress: 65, timeframe: "May 2026 → Aug 2026", swatch: "var(--swatch-amber)", start: 4, len: 4,
    features: [
      { id: "ft-21", name: "SAML for Console", swatch: "var(--swatch-amber)", status: "validation", start: 6, len: 2, release: "Console 2026.09", owner: "Sam Ito" },
      { id: "ft-22", name: "Device trust checks", swatch: "var(--swatch-blue)", status: "planned", start: 7, len: 3, release: "Console 2026.10", owner: "Mo Byrd" },
    ] },
  { id: "init-3", name: "Console migration · wave 2", status: "planned", owner: "Josef Lang", objective: "Consolidate tooling onto Console", progress: 10, timeframe: "Aug 2026 → Nov 2026", swatch: "var(--swatch-vermilion)", start: 7, len: 4,
    features: [
      { id: "ft-31", name: "Ticket importer", swatch: "var(--swatch-vermilion)", status: "planned", start: 7, len: 2, release: "Console 2026.10", owner: "Josef Lang" },
    ] },
  { id: "init-4", name: "Signal capture in the field", status: "idea", owner: "Priya Nair", objective: "Raise knowledge reuse across teams", progress: 0, timeframe: "Sep 2026 → Dec 2026", swatch: "var(--swatch-magenta)", start: 8, len: 4,
    features: [
      { id: "ft-41", name: "Voice notes → signals", swatch: "var(--swatch-violet)", status: "idea", start: 8, len: 3, release: "", owner: "Priya Nair" },
    ] },
];

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DELIVERY = [
  { status: "idea", cards: [
    { title: "Voice notes → signals", swatch: "var(--swatch-violet)", timeframe: "Sep 2026 → Dec 2026", owner: "Priya Nair" },
    { title: "Shift-handoff summaries", swatch: "var(--swatch-magenta)", timeframe: "Q4 2026", owner: "Mo Byrd" },
  ] },
  { status: "planned", cards: [
    { title: "Device trust checks", swatch: "var(--swatch-blue)", timeframe: "Aug 2026 → Oct 2026", owner: "Mo Byrd", tags: [{ label: "Single sign-on everywhere", icon: "diamond" }] },
    { title: "Ticket importer", swatch: "var(--swatch-vermilion)", timeframe: "Aug 2026 → Sep 2026", owner: "Josef Lang", tags: [{ label: "Console 2026.10", icon: "flag" }] },
  ] },
  { status: "progress", cards: [
    { title: "Offline-first sync", swatch: "var(--swatch-blue)", timeframe: "Jul 2026 → Sep 2026", owner: "Sam Ito", tags: [{ label: "Guided mobile onboarding", icon: "diamond" }] },
    { title: "SAML for Console", swatch: "var(--swatch-amber)", timeframe: "Jul 2026 → Aug 2026", owner: "Sam Ito" },
  ] },
  { status: "validation", cards: [
    { title: "Setup checklist", swatch: "var(--swatch-teal)", timeframe: "Jun 2026 → Jul 2026", owner: "Ana Rios", tags: [{ label: "Field App 4.2", icon: "flag" }] },
  ] },
  { status: "released", cards: [
    { title: "Unified login page", swatch: "var(--swatch-amber)", timeframe: "May 2026", owner: "Sam Ito", tags: [{ label: "Console 2026.08", icon: "flag" }] },
  ] },
];

export const SIGNALS = [
  { id: "sg-1", team: "Field Ops", author: "Marcus Webb", kind: "Call note", time: "8:45 PM", unread: true,
    text: "We love the web app but our field teams are mostly on mobile and the experience there is… not there yet. Most techs give up during setup and fall back to email.",
    summary: "Field teams stall during mobile setup and revert to email; a guided, step-by-step first run would unblock adoption.",
    sources: "From 1 call · Field Ops", linked: { type: "feature", label: "Setup checklist", swatch: "var(--swatch-teal)" } },
  { id: "sg-2", team: "Support", author: "Lena Ortiz", kind: "Slack thread", time: "6:12 PM", unread: true,
    text: "Third time this week someone rewrote the same troubleshooting answer. We have it in two wikis and a doc — nobody finds any of them.",
    summary: "Duplicate answers persist across three knowledge stores; discovery, not authoring, is the bottleneck.",
    sources: "From 4 messages · Support", linked: { type: "opportunity", label: "One search across tools" } },
  { id: "sg-3", team: "Sales EU", author: "Tom Keller", kind: "Service ticket", time: "Mon 9:02 AM",
    text: "Requesting the weekly pipeline export again. Every Monday I pull the same filtered view and mail it to the region leads.",
    summary: "Weekly manual exports of the same filtered view; scheduled delivery to email would remove the chore.",
    sources: "From 3 tickets · Sales EU", linked: { type: "feature", label: "Scheduled exports", swatch: "var(--swatch-amber)" } },
  { id: "sg-4", team: "Field Ops", author: "Rosa Alvine", kind: "Survey response", time: "Fri 4:40 PM",
    text: "Offline mode. That's it. Basements and rural sites have no coverage and the app is a brick there.",
    summary: "No-coverage sites make the app unusable; offline-first sync is the single most requested capability.",
    sources: "From 9 responses · Field Ops", linked: { type: "feature", label: "Offline-first sync", swatch: "var(--swatch-blue)" } },
  { id: "sg-5", team: "Internal Systems", author: "Dana Fox", kind: "Email", time: "Thu 11:20 AM",
    text: "Legacy asset tracker exports break every time IT rotates certificates. Can Console own this workflow already?",
    summary: "Legacy tracker integration is brittle; migrating the workflow into Console would end recurring breakage.",
    sources: "From 2 emails · Internal Systems", linked: { type: "initiative", label: "Console migration · wave 2" } },
];

export const OPPORTUNITIES = [
  { id: "op-1", title: "Guided setup for field teams", strength: "High signal", findings: 12, okr: "Increase Field App adoption",
    statement: "Technicians abandon setup on mobile and revert to email. A guided first-run with progress steps unblocks the largest adoption gap.",
    sources: "12 findings · 3 teams · roadmap gap: onboarding" },
  { id: "op-2", title: "Scheduled report exports", strength: "Medium signal", findings: 6, okr: "Consolidate tooling onto Console",
    statement: "Ops and sales re-export identical filtered views weekly. Scheduled, filtered exports to email or Slack remove a recurring chore.",
    sources: "6 findings · 2 teams · competitive: parity gap" },
  { id: "op-3", title: "One search across tools", strength: "Medium signal", findings: 5, okr: "Raise knowledge reuse across teams",
    statement: "Answers exist in three stores but aren't found. A single ask-surface over all knowledge cuts duplicate authoring.",
    sources: "5 findings · 4 teams · strategy: knowledge reuse" },
];

export const SKILLS = [
  { name: "Summarize entity", desc: "Tiered rollups for any product, objective, or feature.", enabled: true },
  { name: "Draft spec from signals", desc: "Delivery-ready spec grounded in linked signals.", enabled: true },
  { name: "Weekly opportunity briefing", desc: "Top three evidence-backed problems, every Monday.", enabled: true },
  { name: "Competitive scan", desc: "Watches selected vendors for relevant changes.", enabled: false },
];

export const AUTOMATIONS = [
  { name: "Monday adoption digest", freq: "Weekly · Mon 9:00 AM", skill: "Summarize entity", output: "Field Platform space", active: true },
  { name: "Signal triage", freq: "Hourly", skill: "Draft spec from signals", output: "Inbox", active: true },
];
