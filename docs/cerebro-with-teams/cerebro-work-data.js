// Cerebro work layer — spaces, projects, lists, items, cycles.
export const ITEM_TYPES = [
  { id: "task", name: "Task", icon: "circle-check", color: "var(--cortex-500)" },
  { id: "bug", name: "Bug", icon: "bug", color: "var(--danger-500)" },
  { id: "milestone", name: "Milestone", icon: "milestone", color: "var(--swatch-amber)" },
  { id: "request", name: "Request", icon: "inbox", color: "var(--swatch-teal)" },
  { id: "epic", name: "Epic", icon: "hexagon", color: "var(--swatch-violet)" },
];

export const PRIORITIES = [
  { id: "urgent", name: "Urgent", icon: "circle-alert", color: "var(--danger-500)" },
  { id: "high", name: "High", icon: "signal-high", color: "var(--swatch-vermilion)" },
  { id: "medium", name: "Medium", icon: "signal-medium", color: "var(--warn-500)" },
  { id: "low", name: "Low", icon: "signal-low", color: "var(--swatch-sky)" },
  { id: "none", name: "None", icon: "ban", color: "var(--n-400)" },
];

export const PROJECT_STATES = [
  { id: "draft", name: "Draft", color: "var(--n-400)", hollow: true },
  { id: "planning", name: "Planning", color: "var(--cortex-400)" },
  { id: "execution", name: "Execution", color: "var(--warn-500)" },
  { id: "monitoring", name: "Monitoring", color: "var(--swatch-sky)" },
  { id: "completed", name: "Completed", color: "var(--success-500)" },
];

export const STATUS_TEMPLATES = [
  { id: "custom", name: "Custom" },
  { id: "cerebro", name: "Cerebro flow" },
  { id: "marketing", name: "Marketing" },
  { id: "simple", name: "Simple" },
];

const cerebroFlow = () => ([
  { id: "backlog", name: "Backlog", group: "active", color: "var(--n-400)", hollow: true },
  { id: "todo", name: "Todo", group: "active", color: "var(--n-500)" },
  { id: "progress", name: "In progress", group: "active", color: "var(--warn-500)" },
  { id: "review", name: "In review", group: "active", color: "var(--swatch-sky)" },
  { id: "done", name: "Done", group: "done", color: "var(--success-500)" },
  { id: "cancelled", name: "Cancelled", group: "closed", color: "var(--n-400)" },
]);

export const STATUS_PRESETS = {
  cerebro: cerebroFlow(),
  marketing: [
    { id: "idea", name: "Idea", group: "active", color: "var(--n-400)", hollow: true },
    { id: "drafting", name: "Drafting", group: "active", color: "var(--warn-500)" },
    { id: "review", name: "In review", group: "active", color: "var(--swatch-sky)" },
    { id: "scheduled", name: "Scheduled", group: "active", color: "var(--cortex-400)" },
    { id: "live", name: "Live", group: "done", color: "var(--success-500)" },
    { id: "killed", name: "Killed", group: "closed", color: "var(--n-400)" },
  ],
  simple: [
    { id: "todo", name: "Todo", group: "active", color: "var(--n-500)", hollow: true },
    { id: "doing", name: "Doing", group: "active", color: "var(--warn-500)" },
    { id: "done", name: "Done", group: "done", color: "var(--success-500)" },
    { id: "dropped", name: "Dropped", group: "closed", color: "var(--n-400)" },
  ],
};

export const SPACES = [
  { id: "sp-org", name: "Organization", kind: "organizational", access: "public", perm: "Full edit", swatch: "var(--n-700)", letter: "O",
    description: "Org-wide boards and shared views. Everything here is visible to the whole company.",
    members: ["Maya Chen", "Josef Lang", "Ana Rios", "Sam Ito"], teams: [], statuses: cerebroFlow(), statusTpl: "cerebro" },
  { id: "sp-field", name: "Field Platform", kind: "team", access: "public", perm: "Edit", swatch: "var(--swatch-teal)", letter: "F",
    description: "Delivery workspace for the Field Platform group: onboarding, sync, and app quality.",
    members: ["Maya Chen", "Ana Rios", "Sam Ito", "Elena Vasquez", "Priya Nair"], teams: [], statuses: cerebroFlow(), statusTpl: "cerebro",
    views: [{ label: "Delivery planning (Sample)", view: "delivery", icon: "table-2" }, { label: "Features board", view: "features", icon: "square-stack" }] },
  { id: "sp-ops", name: "Operations", kind: "team", access: "public", perm: "Comment", swatch: "var(--swatch-vermilion)", letter: "O",
    description: "Facility rollouts, vendor work, and readiness tracking for the ops group.",
    members: ["Marcus Webb", "Mo Byrd", "Dana Fox", "Maya Chen"], teams: ["Field Ops"],
    statuses: [
      { id: "todo", name: "Todo", group: "active", color: "var(--n-500)", hollow: true },
      { id: "progress", name: "In progress", group: "active", color: "var(--warn-500)" },
      { id: "blocked", name: "Blocked", group: "active", color: "var(--danger-500)" },
      { id: "done", name: "Done", group: "done", color: "var(--success-500)" },
      { id: "wontdo", name: "Won't do", group: "closed", color: "var(--n-400)" },
    ], statusTpl: "custom", views: [{ label: "Kanban roadmap (Sample)", view: "kanban", icon: "kanban" }] },
  { id: "sp-launch", name: "Launch war room", kind: "shared", access: "private", perm: "Edit", swatch: "var(--swatch-magenta)", letter: "L",
    description: "Private space for the Field App GA moment — campaign, comms, and launch readiness.",
    members: ["Maya Chen", "Ana Rios", "Priya Nair", "Josef Lang"], teams: ["Field Ops"], statuses: STATUS_PRESETS.marketing.map((s) => ({ ...s })), statusTpl: "marketing",
    views: [{ label: "Initiatives roadmap (Sample)", view: "roadmap", icon: "calendar-range" }] },
  { id: "sp-maya", name: "Maya's desk", kind: "individual", access: "private", perm: "Full edit", swatch: "var(--swatch-sky)", letter: "M",
    description: "Personal space. Only you can see this.",
    members: ["Maya Chen"], teams: [], statuses: STATUS_PRESETS.simple.map((s) => ({ ...s })), statusTpl: "simple" },
];

export const PROJECTS = [
  { id: "pj-onb", spaceId: "sp-field", key: "FLD", name: "Guided onboarding GA", state: "execution", lead: "Ana Rios",
    members: ["Ana Rios", "Elena Vasquez", "Priya Nair", "Maya Chen"], timeframe: "Jun 2026 → Oct 2026", progress: 55,
    initiativeId: "init-1", favorite: true,
    description: "Ship the guided first-run to every field technician: role-based setup, coach marks, and a finish-line moment. GA gate is the Cycle 13 review.",
    workstreams: [
      { id: "ws-flow", name: "First-run flow", timeframe: "Jun 2026 → Aug 2026", progress: 62, lead: "Ana Rios", state: "execution" },
      { id: "ws-coach", name: "Coaching & content", timeframe: "Jul 2026 → Sep 2026", progress: 40, lead: "Elena Vasquez", state: "execution" },
      { id: "ws-launch", name: "GA readiness", timeframe: "Sep 2026 → Oct 2026", progress: 10, lead: "Maya Chen", state: "planning" },
    ] },
  { id: "pj-sync", spaceId: "sp-field", key: "SYN", name: "Offline sync hardening", state: "planning", lead: "Sam Ito",
    members: ["Sam Ito", "Dana Fox"], timeframe: "Jul 2026 → Nov 2026", progress: 20,
    initiativeId: "init-2",
    description: "Close the reliability gap in zero-coverage areas: conflict resolution, delta sync tuning, and a sync health dashboard.",
    workstreams: [
      { id: "ws-core", name: "Sync core", timeframe: "Jul 2026 → Oct 2026", progress: 30, lead: "Sam Ito", state: "execution" },
      { id: "ws-observ", name: "Observability", timeframe: "Aug 2026 → Nov 2026", progress: 5, lead: "Dana Fox", state: "draft" },
    ] },
  { id: "pj-phx", spaceId: "sp-ops", key: "OPS", name: "Phoenix warehouse rollout", state: "execution", lead: "Marcus Webb",
    members: ["Marcus Webb", "Mo Byrd", "Dana Fox"], timeframe: "Jun 2026 → Sep 2026", progress: 45,
    initiativeId: null,
    description: "Stand up the Phoenix distribution site: fit-out, systems provisioning, and go-live readiness by end of September.",
    workstreams: [
      { id: "ws-fit", name: "Fit-out", timeframe: "Jun 2026 → Aug 2026", progress: 70, lead: "Mo Byrd", state: "execution" },
      { id: "ws-sys", name: "Systems", timeframe: "Jul 2026 → Sep 2026", progress: 25, lead: "Dana Fox", state: "execution" },
    ] },
  { id: "pj-camp", spaceId: "sp-launch", key: "LNC", name: "Field App launch campaign", state: "planning", lead: "Priya Nair",
    members: ["Priya Nair", "Maya Chen", "Josef Lang"], timeframe: "Aug 2026 → Oct 2026", progress: 15,
    initiativeId: "init-1",
    description: "The GA moment: positioning, a three-touch email sequence, a refreshed landing page, and a field champions webinar.",
    workstreams: [
      { id: "ws-msg", name: "Messaging", timeframe: "Aug 2026", progress: 35, lead: "Priya Nair", state: "execution" },
      { id: "ws-channels", name: "Channels", timeframe: "Sep 2026 → Oct 2026", progress: 0, lead: "Josef Lang", state: "draft" },
    ] },
];

export const WORK_LISTS = [
  { id: "l-triage", spaceId: "sp-field", key: "TRI", name: "Bug triage", icon: "list-checks" },
  { id: "l-todos", spaceId: "sp-maya", key: "MY", name: "Todos", icon: "list-checks" },
];

export const CYCLES = [
  { id: "cy-11", projectId: "pj-onb", name: "Cycle 11", range: "Jun 30 → Jul 11", status: "completed", scope: 8, done: 8, started: 0, pending: 0,
    lead: "Ana Rios", goal: "Progress tracker + resume-after-interrupt to done." },
  { id: "cy-12", projectId: "pj-onb", name: "Cycle 12", range: "Jul 14 → Jul 25", status: "active", scope: 7, done: 2, started: 4, pending: 1,
    lead: "Ana Rios", goal: "Coach marks shippable; telemetry events wired end to end.",
    ideal: [7, 6.3, 5.6, 4.9, 4.2, 3.5, 2.8, 2.1, 1.4, 0.7, 0], actual: [7, 7, 6, 6, 5, 5, 5, 5], today: 7, startLabel: "Jul 14", endLabel: "Jul 25" },
  { id: "cy-13", projectId: "pj-onb", name: "Cycle 13", range: "Jul 28 → Aug 8", status: "upcoming", scope: 6, done: 0, started: 0, pending: 6,
    lead: "Ana Rios", goal: "GA go/no-go review and localization pass." },
];

// dueN = numeric day for sorting/calendar (Jul 21 2026 = today = 721).
export const WORK_ITEMS = [
  // Guided onboarding GA (FLD) — statuses: backlog/todo/progress/review/done/cancelled
  { id: "wi-1", key: "FLD-1", name: "First-run walkthrough GA", type: "epic", status: "progress", priority: "high", assignee: "Ana Rios",
    due: "Sep 18", dueN: 918, estimate: "XL", projectId: "pj-onb", wsId: "ws-flow", cycleId: null, featureId: "ft-firstrun", startM: 1, lenM: 4,
    description: "Umbrella for everything the GA gate needs: flow, coaching, telemetry, and the fallback path." },
  { id: "wi-2", deps: ["wi-3"], key: "FLD-2", name: "Coach marks on job screen", type: "task", status: "review", priority: "high", assignee: "Elena Vasquez",
    due: "Jul 23", dueN: 723, estimate: "M", projectId: "pj-onb", wsId: "ws-coach", cycleId: "cy-12", featureId: "ft-firstrun", parentId: "wi-1", startM: 2, lenM: 1 },
  { id: "wi-3", key: "FLD-3", name: "Progress tracker states", type: "task", status: "done", priority: "medium", assignee: "Elena Vasquez",
    due: "Jul 17", dueN: 717, estimate: "S", projectId: "pj-onb", wsId: "ws-flow", cycleId: "cy-12", featureId: "ft-firstrun", parentId: "wi-1", startM: 2, lenM: 1 },
  { id: "wi-4", key: "FLD-4", name: "Blank-state coaching copy", type: "task", status: "progress", priority: "medium", assignee: "Priya Nair",
    due: "Jul 24", dueN: 724, estimate: "S", projectId: "pj-onb", wsId: "ws-coach", cycleId: "cy-12", featureId: "ft-firstrun", startM: 2, lenM: 2 },
  { id: "wi-5", key: "FLD-5", name: "Resume-after-interrupt QA pass", type: "task", status: "todo", priority: "high", assignee: "Maya Chen",
    due: "Jul 27", dueN: 727, estimate: "M", projectId: "pj-onb", wsId: "ws-flow", cycleId: "cy-12", featureId: "ft-setup", startM: 2, lenM: 1 },
  { id: "wi-6", key: "FLD-6", name: "Onboarding telemetry events", type: "task", status: "done", priority: "high", assignee: "Sam Ito",
    due: "Jul 16", dueN: 716, estimate: "M", projectId: "pj-onb", wsId: "ws-flow", cycleId: "cy-12", featureId: "ft-firstrun", startM: 2, lenM: 1 },
  { id: "wi-7", key: "FLD-7", name: "Checklist stalls on step 3 offline", type: "bug", status: "progress", priority: "urgent", assignee: "Sam Ito",
    due: "Jul 22", dueN: 722, estimate: "S", projectId: "pj-onb", wsId: "ws-flow", cycleId: "cy-12", featureId: "ft-setup", startM: 2, lenM: 1 },
  { id: "wi-8", deps: ["wi-3"], key: "FLD-8", name: "Finish-line moment animation", type: "task", status: "backlog", priority: "low", assignee: "Elena Vasquez",
    due: "Aug 12", dueN: 812, estimate: "S", projectId: "pj-onb", wsId: "ws-coach", cycleId: "cy-13", featureId: "ft-firstrun", startM: 3, lenM: 1 },
  { id: "wi-9", deps: ["wi-2"], key: "FLD-9", name: "Handoff-to-human fallback", type: "task", status: "review", priority: "medium", assignee: "Ana Rios",
    due: "Jul 25", dueN: 725, estimate: "M", projectId: "pj-onb", wsId: "ws-flow", cycleId: "cy-12", featureId: "ft-setup", startM: 2, lenM: 2 },
  { id: "wi-10", deps: ["wi-4"], key: "FLD-10", name: "Localize first-run copy (ES)", type: "task", status: "backlog", priority: "medium", assignee: "Priya Nair",
    due: "Aug 20", dueN: 820, estimate: "M", projectId: "pj-onb", wsId: "ws-coach", cycleId: "cy-13", featureId: "ft-firstrun", startM: 3, lenM: 2 },
  { id: "wi-11", deps: ["wi-5", "wi-9"], key: "FLD-11", name: "GA go/no-go review", type: "milestone", status: "todo", priority: "high", assignee: "Maya Chen",
    due: "Aug 7", dueN: 807, estimate: "XS", projectId: "pj-onb", wsId: "ws-launch", cycleId: "cy-13", featureId: null, startM: 3, lenM: 1 },
  { id: "wi-12", key: "FLD-12", name: "Support playbook for stuck first runs", type: "request", status: "todo", priority: "low", assignee: "Dana Fox",
    due: "Aug 14", dueN: 814, estimate: "S", projectId: "pj-onb", wsId: "ws-launch", cycleId: null, featureId: null, startM: 3, lenM: 1 },
  // Offline sync hardening (SYN)
  { id: "wi-13", key: "SYN-1", name: "Conflict resolution UX spec", type: "task", status: "progress", priority: "high", assignee: "Sam Ito",
    due: "Jul 29", dueN: 729, estimate: "M", projectId: "pj-sync", wsId: "ws-core", cycleId: null, featureId: "ft-offline", startM: 2, lenM: 2 },
  { id: "wi-14", deps: ["wi-13"], key: "SYN-2", name: "Delta sync backoff tuning", type: "task", status: "todo", priority: "medium", assignee: "Sam Ito",
    due: "Aug 5", dueN: 805, estimate: "M", projectId: "pj-sync", wsId: "ws-core", cycleId: null, featureId: "ft-offline", startM: 3, lenM: 2 },
  { id: "wi-15", key: "SYN-3", name: "Duplicate jobs after reconnect", type: "bug", status: "progress", priority: "urgent", assignee: "Dana Fox",
    due: "Jul 24", dueN: 724, estimate: "S", projectId: "pj-sync", wsId: "ws-core", cycleId: null, featureId: "ft-offline", startM: 2, lenM: 1 },
  { id: "wi-16", deps: ["wi-13"], key: "SYN-4", name: "Sync health dashboard", type: "task", status: "backlog", priority: "medium", assignee: "Dana Fox",
    due: "Sep 4", dueN: 904, estimate: "L", projectId: "pj-sync", wsId: "ws-observ", cycleId: null, featureId: "ft-offline", startM: 4, lenM: 2 },
  { id: "wi-17", key: "SYN-5", name: "Field kill-switch for sync", type: "task", status: "backlog", priority: "low", assignee: "Sam Ito",
    due: "Sep 25", dueN: 925, estimate: "S", projectId: "pj-sync", wsId: "ws-observ", cycleId: null, featureId: null, startM: 4, lenM: 1 },
  // Bug triage list (TRI, sp-field statuses)
  { id: "wi-18", key: "TRI-1", name: "App crash on photo capture (Pixel 8)", type: "bug", status: "progress", priority: "urgent", assignee: "Sam Ito",
    due: "Jul 22", dueN: 722, estimate: "S", listId: "l-triage", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-19", key: "TRI-2", name: "Wrong timezone on job cards", type: "bug", status: "todo", priority: "high", assignee: "Elena Vasquez",
    due: "Jul 28", dueN: 728, estimate: "S", listId: "l-triage", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-20", key: "TRI-3", name: "Signature pad ghost strokes", type: "bug", status: "backlog", priority: "medium", assignee: "Ana Rios",
    due: "Aug 6", dueN: 806, estimate: "S", listId: "l-triage", featureId: null, startM: 3, lenM: 1 },
  { id: "wi-21", key: "TRI-4", name: "Offline badge flickers on LTE handoff", type: "bug", status: "backlog", priority: "low", assignee: "Sam Ito",
    due: "Aug 13", dueN: 813, estimate: "XS", listId: "l-triage", featureId: "ft-offline", startM: 3, lenM: 1 },
  { id: "wi-22", key: "TRI-5", name: "Push tokens expire silently", type: "bug", status: "done", priority: "high", assignee: "Dana Fox",
    due: "Jul 15", dueN: 715, estimate: "M", listId: "l-triage", featureId: null, startM: 2, lenM: 1 },
  // Phoenix warehouse rollout (OPS) — statuses: todo/progress/blocked/done/wontdo
  { id: "wi-23", key: "OPS-1", name: "Rack layout sign-off", type: "milestone", status: "done", priority: "high", assignee: "Marcus Webb",
    due: "Jul 10", dueN: 710, estimate: "XS", projectId: "pj-phx", wsId: "ws-fit", featureId: null, startM: 1, lenM: 2 },
  { id: "wi-24", key: "OPS-2", name: "Vendor contract countersign", type: "task", status: "blocked", priority: "urgent", assignee: "Marcus Webb",
    due: "Jul 23", dueN: 723, estimate: "S", projectId: "pj-phx", wsId: "ws-fit", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-25", deps: ["wi-24"], key: "OPS-3", name: "Rack delivery + install window", type: "task", status: "blocked", priority: "high", assignee: "Mo Byrd",
    due: "Aug 1", dueN: 801, estimate: "L", projectId: "pj-phx", wsId: "ws-fit", featureId: null, startM: 2, lenM: 2 },
  { id: "wi-26", key: "OPS-4", name: "Forklift certification schedule", type: "task", status: "progress", priority: "medium", assignee: "Mo Byrd",
    due: "Jul 30", dueN: 730, estimate: "S", projectId: "pj-phx", wsId: "ws-fit", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-27", deps: ["wi-25"], key: "OPS-5", name: "WMS device provisioning (40 scanners)", type: "task", status: "progress", priority: "high", assignee: "Dana Fox",
    due: "Aug 8", dueN: 808, estimate: "M", projectId: "pj-phx", wsId: "ws-sys", featureId: null, startM: 2, lenM: 2 },
  { id: "wi-28", key: "OPS-6", name: "Network drops — floor 2", type: "task", status: "todo", priority: "medium", assignee: "Dana Fox",
    due: "Aug 15", dueN: 815, estimate: "M", projectId: "pj-phx", wsId: "ws-sys", featureId: null, startM: 3, lenM: 1 },
  { id: "wi-29", key: "OPS-7", name: "Safety walkthrough with county inspector", type: "task", status: "todo", priority: "high", assignee: "Marcus Webb",
    due: "Aug 21", dueN: 821, estimate: "S", projectId: "pj-phx", wsId: "ws-fit", featureId: null, startM: 3, lenM: 1 },
  { id: "wi-30", deps: ["wi-27", "wi-29"], key: "OPS-8", name: "Go-live readiness review", type: "milestone", status: "todo", priority: "urgent", assignee: "Marcus Webb",
    due: "Sep 12", dueN: 912, estimate: "XS", projectId: "pj-phx", wsId: "ws-sys", featureId: null, startM: 4, lenM: 1 },
  // Field App launch campaign (LNC) — statuses: idea/drafting/review/scheduled/live/killed
  { id: "wi-31", key: "LNC-1", name: "Campaign brief", type: "task", status: "review", priority: "high", assignee: "Priya Nair",
    due: "Jul 24", dueN: 724, estimate: "S", projectId: "pj-camp", wsId: "ws-msg", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-32", key: "LNC-2", name: "Positioning + message house", type: "task", status: "drafting", priority: "high", assignee: "Priya Nair",
    due: "Jul 31", dueN: 731, estimate: "M", projectId: "pj-camp", wsId: "ws-msg", featureId: null, startM: 2, lenM: 2 },
  { id: "wi-33", deps: ["wi-32"], key: "LNC-3", name: "Launch email sequence (3 touches)", type: "task", status: "idea", priority: "medium", assignee: "Josef Lang",
    due: "Aug 18", dueN: 818, estimate: "M", projectId: "pj-camp", wsId: "ws-channels", featureId: null, startM: 3, lenM: 2 },
  { id: "wi-34", deps: ["wi-32"], key: "LNC-4", name: "Landing page refresh", type: "task", status: "idea", priority: "medium", assignee: "Josef Lang",
    due: "Sep 2", dueN: 902, estimate: "L", projectId: "pj-camp", wsId: "ws-channels", featureId: null, startM: 3, lenM: 2 },
  { id: "wi-35", deps: ["wi-33"], key: "LNC-5", name: "Field champions webinar", type: "task", status: "idea", priority: "low", assignee: "Maya Chen",
    due: "Sep 16", dueN: 916, estimate: "M", projectId: "pj-camp", wsId: "ws-channels", featureId: null, startM: 4, lenM: 1 },
  { id: "wi-36", key: "LNC-6", name: "GA dry run with support", type: "task", status: "drafting", priority: "high", assignee: "Maya Chen",
    due: "Aug 26", dueN: 826, estimate: "S", projectId: "pj-camp", wsId: "ws-msg", featureId: null, startM: 3, lenM: 1 },
  { id: "wi-37", key: "LNC-7", name: "Press + analyst notes", type: "task", status: "killed", priority: "none", assignee: "Priya Nair",
    due: "Sep 9", dueN: 909, estimate: "S", projectId: "pj-camp", wsId: "ws-channels", featureId: null, startM: 4, lenM: 1 },
  // Maya's desk — Todos list (MY, statuses: todo/doing/done/dropped)
  { id: "wi-38", key: "MY-1", name: "Prep FieldOps Summit talk", type: "task", status: "doing", priority: "high", assignee: "Maya Chen",
    due: "Jul 25", dueN: 725, estimate: "M", listId: "l-todos", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-39", key: "MY-2", name: "Review Ana's onboarding spec", type: "task", status: "todo", priority: "high", assignee: "Maya Chen",
    due: "Jul 21", dueN: 721, estimate: "S", listId: "l-todos", featureId: "ft-firstrun", startM: 2, lenM: 1 },
  { id: "wi-40", key: "MY-3", name: "Book flights for Phoenix visit", type: "task", status: "todo", priority: "medium", assignee: "Maya Chen",
    due: "Jul 22", dueN: 722, estimate: "XS", listId: "l-todos", featureId: null, startM: 2, lenM: 1 },
  { id: "wi-41", key: "MY-4", name: "Q3 headcount ask — one-pager", type: "task", status: "todo", priority: "low", assignee: "Maya Chen",
    due: "Aug 4", dueN: 804, estimate: "S", listId: "l-todos", featureId: null, startM: 3, lenM: 1 },
  { id: "wi-42", key: "MY-5", name: "Expense report — June travel", type: "task", status: "done", priority: "none", assignee: "Maya Chen",
    due: "Jul 14", dueN: 714, estimate: "XS", listId: "l-todos", featureId: null, startM: 2, lenM: 1 },
];

// Custom fields — per-container definitions. Values live on the field (keyed by item id)
// so work items stay clean. Option colors use DS swatch tokens.
export const CUSTOM_FIELDS = {
  "pj-onb": [
    { id: "cf-conf", name: "Confidence", type: "rating", values: { "wi-1": 4, "wi-2": 3, "wi-4": 3, "wi-5": 2, "wi-7": 2, "wi-8": 4, "wi-9": 4, "wi-10": 3, "wi-11": 3, "wi-12": 3 } },
    { id: "cf-eff", name: "Effort (days)", type: "number", unit: "d", values: { "wi-2": 4, "wi-4": 2, "wi-5": 3, "wi-7": 1, "wi-8": 2, "wi-9": 5, "wi-10": 6, "wi-12": 2 } },
    { id: "cf-chan", name: "Rollout channel", type: "dropdown", options: [{ v: "pilot", label: "Pilot cohort", color: "var(--swatch-teal)" }, { v: "beta", label: "Field beta", color: "var(--swatch-sky)" }, { v: "ga", label: "All technicians", color: "var(--swatch-violet)" }], values: { "wi-1": "ga", "wi-2": "beta", "wi-3": "pilot", "wi-4": "beta", "wi-5": "pilot", "wi-6": "pilot", "wi-7": "pilot", "wi-8": "ga", "wi-9": "beta", "wi-10": "ga", "wi-11": "ga" } },
    { id: "cf-l10n", name: "Localization ready", type: "checkbox", values: { "wi-3": true, "wi-6": true } },
  ],
  "pj-phx": [
    { id: "cf-vendor", name: "Vendor", type: "dropdown", options: [{ v: "acme", label: "Acme Racking", color: "var(--swatch-vermilion)" }, { v: "flux", label: "FluxNet", color: "var(--swatch-sky)" }, { v: "inhouse", label: "In-house", color: "var(--swatch-teal)" }], values: { "wi-24": "acme", "wi-25": "acme", "wi-26": "inhouse", "wi-27": "flux", "wi-28": "flux", "wi-29": "inhouse" } },
    { id: "cf-budget", name: "Budget", type: "money", values: { "wi-23": 4000, "wi-25": 84000, "wi-26": 3600, "wi-27": 22500, "wi-28": 9800 } },
    { id: "cf-permit", name: "Permit needed", type: "checkbox", values: { "wi-25": true, "wi-28": true, "wi-29": true } },
  ],
  "l-triage": [
    { id: "cf-sev", name: "Severity", type: "dropdown", options: [{ v: "s1", label: "S1 · Data loss", color: "var(--danger-500)" }, { v: "s2", label: "S2 · Broken flow", color: "var(--swatch-vermilion)" }, { v: "s3", label: "S3 · Papercut", color: "var(--warn-500)" }], values: { "wi-18": "s1", "wi-19": "s2", "wi-20": "s3", "wi-21": "s3", "wi-22": "s2" } },
    { id: "cf-dev", name: "Devices", type: "labels", options: [{ v: "pixel", label: "Pixel", color: "var(--swatch-sky)" }, { v: "iphone", label: "iPhone", color: "var(--swatch-teal)" }, { v: "tablet", label: "Tablet", color: "var(--swatch-amber)" }], values: { "wi-18": ["pixel"], "wi-19": ["pixel", "iphone"], "wi-20": ["tablet"], "wi-21": ["pixel", "iphone"], "wi-22": ["iphone"] } },
    { id: "cf-rep", name: "Repro rate", type: "progress", values: { "wi-18": 90, "wi-19": 60, "wi-20": 25, "wi-21": 40, "wi-22": 100 } },
  ],
  "pj-camp": [
    { id: "cf-aud", name: "Audience", type: "labels", options: [{ v: "tech", label: "Technicians", color: "var(--swatch-teal)" }, { v: "mgr", label: "Field managers", color: "var(--swatch-sky)" }, { v: "exec", label: "Execs", color: "var(--swatch-violet)" }], values: { "wi-31": ["mgr", "exec"], "wi-32": ["tech", "mgr"], "wi-33": ["tech"], "wi-34": ["tech", "mgr"], "wi-35": ["tech"], "wi-36": ["mgr"] } },
    { id: "cf-cost", name: "Est. spend", type: "money", values: { "wi-33": 1200, "wi-34": 8000, "wi-35": 2500 } },
  ],
};

// Saved views per container. Configs are partial — the app fills in defaults
// (filters/sort/group/fields/layout options). "__me" resolves to the current user.
export const SAVED_VIEWS = {
  "pj-onb": { defaultId: "v-onb-all", views: [
    { id: "v-onb-all", name: "All work", shared: true, createdBy: "Ana Rios", config: { layout: "list", group: "status", sort: [{ f: "priority", dir: "asc" }] } },
    { id: "v-onb-board", name: "Board", shared: true, createdBy: "Ana Rios", config: { layout: "board", group: "status", board: { size: "cozy", swim: "none" } } },
    { id: "v-onb-gantt", name: "Delivery plan", shared: true, createdBy: "Maya Chen", config: { layout: "gantt", group: "workstream", sort: [{ f: "due", dir: "asc" }] } },
    { id: "v-onb-c13", name: "Cycle 13 scope", shared: true, createdBy: "Ana Rios", config: { layout: "table", group: "none", filters: [{ f: "cycle", op: "is", vals: ["cy-13"] }], sort: [{ f: "priority", dir: "asc" }], fields: ["key", "type", "status", "priority", "assignee", "due", "cf-conf", "cf-eff", "cf-chan"] } },
    { id: "v-onb-mine", name: "My focus", shared: false, createdBy: "Maya Chen", config: { layout: "list", group: "due", filters: [{ f: "assignee", op: "is", vals: ["__me"] }, { f: "status", op: "isnot", vals: ["done", "cancelled"] }], sort: [{ f: "due", dir: "asc" }] } },
  ] },
  "pj-sync": { defaultId: "v-syn-all", views: [
    { id: "v-syn-all", name: "All work", shared: true, createdBy: "Sam Ito", config: { layout: "list", group: "status" } },
    { id: "v-syn-gantt", name: "Plan", shared: true, createdBy: "Sam Ito", config: { layout: "gantt", group: "workstream" } },
  ] },
  "pj-phx": { defaultId: "v-phx-all", views: [
    { id: "v-phx-all", name: "All work", shared: true, createdBy: "Marcus Webb", config: { layout: "list", group: "status", fields: ["key", "type", "status", "priority", "assignee", "due", "cf-vendor", "cf-budget"] } },
    { id: "v-phx-gantt", name: "Rollout plan", shared: true, createdBy: "Marcus Webb", config: { layout: "gantt", group: "workstream", sort: [{ f: "due", dir: "asc" }] } },
    { id: "v-phx-blocked", name: "Blocked", shared: true, createdBy: "Mo Byrd", config: { layout: "list", group: "none", filters: [{ f: "status", op: "is", vals: ["blocked"] }] } },
  ] },
  "pj-camp": { defaultId: "v-camp-all", views: [
    { id: "v-camp-all", name: "All work", shared: true, createdBy: "Priya Nair", config: { layout: "list", group: "status", fields: ["key", "type", "status", "priority", "assignee", "due", "cf-aud", "cf-cost"] } },
    { id: "v-camp-cal", name: "Content calendar", shared: true, createdBy: "Priya Nair", config: { layout: "calendar", group: "none" } },
  ] },
  "l-triage": { defaultId: "v-tri-all", views: [
    { id: "v-tri-all", name: "All bugs", shared: true, createdBy: "Sam Ito", config: { layout: "list", group: "priority", sort: [{ f: "due", dir: "asc" }], fields: ["key", "type", "status", "priority", "assignee", "due", "cf-sev", "cf-dev"] } },
    { id: "v-tri-sev", name: "Severity table", shared: true, createdBy: "Dana Fox", config: { layout: "table", group: "cf-sev", sort: [{ f: "cf-rep", dir: "desc" }], fields: ["key", "type", "status", "assignee", "due", "cf-sev", "cf-dev", "cf-rep"] } },
    { id: "v-tri-board", name: "Board", shared: true, createdBy: "Sam Ito", config: { layout: "board", group: "status" } },
  ] },
  "l-todos": { defaultId: "v-my-all", views: [
    { id: "v-my-all", name: "Todos", shared: false, createdBy: "Maya Chen", config: { layout: "list", group: "status", sort: [{ f: "due", dir: "asc" }] } },
  ] },
};

export const WORK_DIGEST = [
  { icon: "iteration-cw", text: "Cycle 12 is trailing the ideal line by 3 items — four are parked in review; that column is the bottleneck.", meta: "From Cycle 12 · Guided onboarding GA" },
  { icon: "circle-alert", text: "Phoenix rollout has 2 blocked items on the same vendor dependency; the countersign is 2 days overdue tomorrow.", meta: "From 8 items · Phoenix warehouse rollout" },
  { icon: "radar", text: "3 new signals mention first-run stalls on step 3 — matches the open urgent bug in Cycle 12.", meta: "From 3 signals · Feedback" },
];
