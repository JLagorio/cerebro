// Cerebro seed data — Meridian internal product org (fictional). All content "(Sample)"-free by design; internal tool.
export const CURRENT_USER = "Maya Chen";

export const USERS = [
  { id: "u-maya", name: "Maya Chen", role: "Group product manager", team: "Field Platform", owns: 3 },
  { id: "u-josef", name: "Josef Lang", role: "Product manager", team: "Internal Systems", owns: 2 },
  { id: "u-ana", name: "Ana Rios", role: "Product manager", team: "Field Platform", owns: 2 },
  { id: "u-sam", name: "Sam Ito", role: "Engineering lead", team: "Platform", owns: 2 },
  { id: "u-priya", name: "Priya Nair", role: "Product manager", team: "Knowledge", owns: 1 },
  { id: "u-mo", name: "Mo Byrd", role: "Operations PM", team: "Finance Ops", owns: 1 },
  { id: "u-elena", name: "Elena Vasquez", role: "Design lead", team: "Field Platform", owns: 0 },
  { id: "u-marcus", name: "Marcus Webb", role: "Head of field ops", team: "Field Ops", owns: 0 },
  { id: "u-lena", name: "Lena Ortiz", role: "Support lead", team: "Support", owns: 0 },
  { id: "u-tom", name: "Tom Keller", role: "Sales operations", team: "Sales EU", owns: 0 },
  { id: "u-dana", name: "Dana Fox", role: "IT systems admin", team: "Internal Systems", owns: 0 },
  { id: "u-rosa", name: "Rosa Alvine", role: "Field supervisor", team: "Field Ops", owns: 0 },
];

export const TEAMS = [
  { id: "t-fieldops", name: "Field Ops", kind: "Stakeholder team", lead: "Marcus Webb", members: 240, signals: 4 },
  { id: "t-support", name: "Support", kind: "Stakeholder team", lead: "Lena Ortiz", members: 38, signals: 2 },
  { id: "t-saleseu", name: "Sales EU", kind: "Stakeholder team", lead: "Tom Keller", members: 22, signals: 2 },
  { id: "t-intsys", name: "Internal Systems", kind: "Product team", lead: "Josef Lang", members: 14, signals: 1 },
  { id: "t-fieldplat", name: "Field Platform", kind: "Product team", lead: "Maya Chen", members: 18, signals: 0 },
  { id: "t-data", name: "Data & Analytics", kind: "Product team", lead: "Sam Ito", members: 11, signals: 1 },
  { id: "t-finops", name: "Finance Ops", kind: "Stakeholder team", lead: "Mo Byrd", members: 9, signals: 1 },
  { id: "t-cs", name: "Customer Success", kind: "Stakeholder team", lead: "Priya Nair", members: 16, signals: 0 },
];

// Timeline window: May 2026 (idx 0) → Dec 2026 (idx 7). Today = Jul 19 → col 2 + 19/31.
export const MONTHS = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const OBJECTIVES = [
  { id: "obj-1", name: "Increase Field App adoption (Sample Objective)", healthAgo: "8 minutes ago", timeframe: "2026", owner: "Maya Chen", team: "Field Platform", health: "on", progress: 40,
    description: "Field technicians default to email and phone because the app's first-run experience stalls them. This objective tracks making Field App the daily tool of record.",
    checkins: [{ week: "Jul 13", health: "on", note: "Setup rework in beta with 40 reps; early completion up 9 pts." }, { week: "Jul 6", health: "on", note: "Offline sync milestone hit; media queue slipping a week." }, { week: "Jun 29", health: "risk", note: "Onboarding abandonment flat; guided first run moved up a sprint." }],
    krs: [
      { id: "kr-11", name: "5,000 weekly active technicians (Sample KR)", timeframe: "Q3, 2026 – Q4, 2026", owner: "Ana Rios", health: "on", progress: 62, current: "3,100 / 5,000", trend: [2400, 2650, 2900, 3100] },
      { id: "kr-12", name: "First setup under 10 minutes (Sample KR)", timeframe: "Q3, 2026 – Q4, 2026", owner: "Sam Ito", health: "risk", progress: 35, current: "18 min median", trend: [24, 21, 19, 18] },
      { id: "kr-13", name: "95% job coverage in offline mode (Sample KR)", timeframe: "Q4, 2026", owner: "Ana Rios", health: "on", progress: 55, current: "78% today", trend: [61, 66, 72, 78] },
    ] },
  { id: "obj-2", name: "Consolidate tooling onto Console (Sample Objective)", healthAgo: "2 hours ago", timeframe: "2026", owner: "Josef Lang", team: "Internal Systems", health: "risk", progress: 25,
    description: "Twelve legacy tools still hold workflows hostage. Consolidation cuts license spend and puts every service request behind one queue.",
    checkins: [{ week: "Jul 13", health: "risk", note: "Wave 2 blocked on ticket importer field mapping." }, { week: "Jul 6", health: "risk", note: "SAML in validation with IT Security; device trust scoped." }, { week: "Jun 29", health: "on", note: "Unified login shipped in 2026.08." }],
    krs: [
      { id: "kr-21", name: "Migrate 12 legacy tools (Sample KR)", timeframe: "2026", owner: "Josef Lang", health: "risk", progress: 42, current: "5 / 12 migrated", trend: [3, 4, 5, 5] },
      { id: "kr-22", name: "95% of service requests via Console (Sample KR)", timeframe: "Q4, 2026", owner: "Mo Byrd", health: "on", progress: 55, current: "71% today", trend: [58, 63, 68, 71] },
    ] },
  { id: "obj-3", name: "Raise knowledge reuse across teams (Sample Objective)", healthAgo: "yesterday", timeframe: "H2 2026", owner: "Priya Nair", team: "Knowledge", health: "on", progress: 55,
    description: "Answers exist but don't travel. Cerebro should make the second ask of any question instant.",
    checkins: [{ week: "Jul 13", health: "on", note: "Spec citations at 64%; portal search prototype in review." }, { week: "Jul 6", health: "on", note: "Signal intake form drafted with Field Ops." }, { week: "Jun 29", health: "on", note: "Baseline answer time measured: 6.5 min median." }],
    krs: [
      { id: "kr-31", name: "80% of specs cite at least one signal (Sample KR)", timeframe: "Q3, 2026 – Q4, 2026", owner: "Priya Nair", health: "on", progress: 71, current: "64% today", trend: [41, 52, 58, 64] },
      { id: "kr-32", name: "Median answer time under 2 minutes (Sample KR)", timeframe: "Q4, 2026", owner: "Mo Byrd", health: "none", progress: 0, current: "Not started", trend: [] },
    ] },
  { id: "obj-4", name: "Cut dispatch-to-arrival time 20% (Sample Objective)", healthAgo: "2 days ago", timeframe: "2026", owner: "Ana Rios", team: "Field Platform", health: "on", progress: 48,
    description: "Jobs sit unassigned while coordinators juggle spreadsheets. Smart assignment and live ETAs shorten the path from request to doorbell.",
    checkins: [{ week: "Jul 13", health: "on", note: "Auto-assign pilot covering 2 regions; median down 4 min." }, { week: "Jul 6", health: "on", note: "Territory rules signed off by Field Ops." }, { week: "Jun 29", health: "on", note: "Optimizer v2 cut planned drive time 11%." }],
    krs: [
      { id: "kr-41", name: "Median dispatch-to-arrival 42 → 34 min (Sample KR)", timeframe: "Q3, 2026 – Q4, 2026", owner: "Ana Rios", health: "on", progress: 50, current: "38 min median", trend: [42, 41, 39, 38] },
      { id: "kr-42", name: "70% of jobs auto-assigned (Sample KR)", timeframe: "Q4, 2026", owner: "Sam Ito", health: "risk", progress: 30, current: "21% today", trend: [8, 12, 17, 21] },
    ] },
  { id: "obj-5", name: "Make billing invisible (Sample Objective)", healthAgo: "5 days ago", timeframe: "H2 2026", owner: "Mo Byrd", team: "Finance Ops", health: "risk", progress: 30,
    description: "Finance spends Fridays chasing mismatched invoices. Reconciliation should be an exception queue, not a spreadsheet ritual.",
    checkins: [{ week: "Jul 13", health: "risk", note: "Match-rule coverage stuck at 74%; exception queue UX in design." }, { week: "Jul 6", health: "risk", note: "Two new payment providers added edge cases." }, { week: "Jun 29", health: "on", note: "Auto-reconciliation dark-launched on 10% of invoices." }],
    krs: [
      { id: "kr-51", name: "99% of invoices auto-reconciled (Sample KR)", timeframe: "Q4, 2026", owner: "Mo Byrd", health: "risk", progress: 35, current: "74% today", trend: [61, 68, 71, 74] },
      { id: "kr-52", name: "Billing disputes under 0.5% (Sample KR)", timeframe: "Q4, 2026", owner: "Josef Lang", health: "on", progress: 60, current: "0.8% today", trend: [1.4, 1.1, 0.9, 0.8] },
    ] },
  { id: "obj-6", name: "Platform reliability at 99.95% (Sample Objective)", healthAgo: "38 minutes ago", timeframe: "2026", owner: "Sam Ito", team: "Platform", health: "on", progress: 62,
    description: "Every product above rides the same rails. Reliability is a feature the field notices only when it's missing.",
    checkins: [{ week: "Jul 13", health: "on", note: "p95 at 340ms after cache work; anomaly alerts in pilot." }, { week: "Jul 6", health: "on", note: "MTTR down to 52 min with new runbooks." }, { week: "Jun 29", health: "risk", note: "Two webhook incidents; replay tooling prioritized." }],
    krs: [
      { id: "kr-61", name: "p95 API latency under 300ms (Sample KR)", timeframe: "Q3, 2026 – Q4, 2026", owner: "Sam Ito", health: "on", progress: 70, current: "340ms today", trend: [420, 395, 360, 340] },
      { id: "kr-62", name: "Incident MTTR under 45 minutes (Sample KR)", timeframe: "Q4, 2026", owner: "Dana Fox", health: "on", progress: 58, current: "52 min today", trend: [78, 66, 58, 52] },
    ] },
];

export const INITIATIVES = [
  { id: "init-1", name: "Guided mobile onboarding (Sample Initiative)", status: "progress", owner: "Ana Rios", team: "Field Platform", objectiveId: "obj-1", progress: 40, timeframe: "Jun 2026 → Oct 2026", swatch: "var(--swatch-teal)", start: 1, len: 5,
    description: "A step-by-step first run for field technicians: role-based setup, progress steps, and a checklist that survives interruptions." },
  { id: "init-2", name: "Offline-first field kit (Sample Initiative)", status: "progress", owner: "Sam Ito", team: "Field Platform", objectiveId: "obj-1", progress: 55, timeframe: "May 2026 → Sep 2026", swatch: "var(--swatch-blue)", start: 0, len: 5,
    description: "Sync, conflict resolution, and media queues that keep Field App fully usable in basements and rural dead zones." },
  { id: "init-3", name: "Single sign-on everywhere (Sample Initiative)", status: "progress", owner: "Sam Ito", team: "Internal Systems", objectiveId: "obj-2", progress: 65, timeframe: "May 2026 → Aug 2026", swatch: "var(--swatch-amber)", start: 0, len: 4,
    description: "One identity across Console and every migrated tool: SAML, device trust, and session policies." },
  { id: "init-4", name: "Console migration · wave 2 (Sample Initiative)", status: "planned", owner: "Josef Lang", team: "Internal Systems", objectiveId: "obj-2", progress: 10, timeframe: "Aug 2026 → Nov 2026", swatch: "var(--swatch-vermilion)", start: 3, len: 4,
    description: "Move the next six legacy tools behind Console's queue, starting with the asset tracker and ticket history." },
  { id: "init-5", name: "Signal capture in the field (Sample Initiative)", status: "idea", owner: "Priya Nair", team: "Knowledge", objectiveId: "obj-3", progress: 0, timeframe: "Sep 2026 → Dec 2026", swatch: "var(--swatch-magenta)", start: 4, len: 4,
    description: "Voice notes, portal intake, and shift handoffs that turn field observations into structured signals." },
  { id: "init-6", name: "One search across tools (Sample Initiative)", status: "planned", owner: "Priya Nair", team: "Knowledge", objectiveId: "obj-3", progress: 5, timeframe: "Aug 2026 → Dec 2026", swatch: "var(--swatch-violet)", start: 3, len: 5,
    description: "A single ask-surface over wikis, docs, and tickets so the second ask of any question is instant." },
  { id: "init-7", name: "Smart auto-assignment (Sample Initiative)", status: "progress", owner: "Ana Rios", team: "Field Platform", objectiveId: "obj-4", progress: 45, timeframe: "Jun 2026 → Nov 2026", swatch: "var(--swatch-green)", start: 1, len: 6,
    description: "Skill matching, territory rules, and load balancing that put the right tech on the right job automatically." },
  { id: "init-8", name: "Reconciliation engine (Sample Initiative)", status: "progress", owner: "Mo Byrd", team: "Finance Ops", objectiveId: "obj-5", progress: 35, timeframe: "Jun 2026 → Dec 2026", swatch: "var(--swatch-vermilion)", start: 1, len: 7,
    description: "Match rules and an exception queue that make Friday reconciliation a review, not a rebuild." },
  { id: "init-9", name: "Golden-path observability (Sample Initiative)", status: "progress", owner: "Sam Ito", team: "Platform", objectiveId: "obj-6", progress: 50, timeframe: "May 2026 → Oct 2026", swatch: "var(--swatch-sky)", start: 0, len: 6,
    description: "Anomaly alerts, device health scores, and audit streams across the platform's golden paths." },
];

// Products → components → features (subfeatures inline). start/len on the May–Dec grid.
export const PRODUCTS = [
  { id: "pr-fieldapp", name: "Field App (Sample)", owner: "Maya Chen", description: "Mobile workspace for field technicians: jobs, checklists, and capture that works offline.",
    components: [
      { id: "cm-fa-onb", name: "Onboarding", features: [
        { id: "ft-setup", name: "Setup checklist (Sample)", status: "released", owner: "Ana Rios", swatch: "var(--swatch-teal)", releaseId: "rel-fa42", initiativeId: "init-1", timeframe: "Jun 2026 → Jul 2026", start: 1, len: 2, effort: 5, value: 90, insights: ["sg-1", "sg-6"],
          description: "First-launch checklist with progress steps; survives app restarts and hands off to a human when stuck.",
          subfeatures: [{ id: "sf-setup-1", name: "Role-based steps (Sample)", status: "released", owner: "Ana Rios" }, { id: "sf-setup-2", name: "Resume after interruption (Sample)", status: "released", owner: "Sam Ito" }] },
        { id: "ft-firstrun", name: "Guided first run (Sample)", status: "progress", owner: "Ana Rios", swatch: "var(--swatch-teal)", releaseId: "rel-fa43", initiativeId: "init-1", timeframe: "Jul 2026 → Sep 2026", start: 2, len: 3, effort: 8, value: 100, insights: ["sg-1"],
          description: "In-context walkthrough of the first job: tooltips on mobile, blank-state coaching, and a finish-line moment.",
          subfeatures: [{ id: "sf-fr-1", name: "Progress tracker (Sample)", status: "progress", owner: "Elena Vasquez" }, { id: "sf-fr-2", name: "Coach marks (Sample)", status: "planned", owner: "Elena Vasquez" }] },
      ] },
      { id: "cm-fa-sync", name: "Sync & offline", features: [
        { id: "ft-offline", name: "Offline-first sync (Sample)", status: "progress", owner: "Sam Ito", swatch: "var(--swatch-blue)", releaseId: "rel-fa43", initiativeId: "init-2", timeframe: "Jul 2026 → Sep 2026", start: 2, len: 3, effort: 13, value: 95, insights: ["sg-4"],
          description: "Local-first job data with background delta sync; the app is fully usable with zero coverage.",
          subfeatures: [{ id: "sf-off-1", name: "Conflict resolution (Sample)", status: "progress", owner: "Sam Ito" }, { id: "sf-off-2", name: "Delta sync (Sample)", status: "progress", owner: "Sam Ito" }, { id: "sf-off-3", name: "Media upload queue (Sample)", status: "planned", owner: "Ana Rios" }] },
        { id: "ft-voice", name: "Voice notes → signals (Sample)", status: "idea", owner: "Priya Nair", swatch: "var(--swatch-violet)", releaseId: null, initiativeId: "init-5", timeframe: "Sep 2026 → Dec 2026", start: 4, len: 3, effort: 8, value: 60, insights: ["sg-1"],
          description: "Dictated observations on site become transcribed, linked signals in the knowledge base.", subfeatures: [] },
      ] },
      { id: "cm-fa-job", name: "Job execution", features: [
        { id: "ft-handoff", name: "Shift-handoff summaries (Sample)", status: "idea", owner: "Mo Byrd", swatch: "var(--swatch-magenta)", releaseId: null, initiativeId: "init-5", timeframe: "Q4 2026", start: 5, len: 3, effort: 5, value: 55, insights: ["sg-7"],
          description: "End-of-shift rollup of open jobs, blockers, and parts to hand the next crew.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-console", name: "Console (Sample)", owner: "Josef Lang", description: "Admin and service hub: one queue for every internal request, one place to run the tools.",
    components: [
      { id: "cm-co-access", name: "Access", features: [
        { id: "ft-saml", name: "SAML for Console (Sample)", status: "validation", owner: "Sam Ito", swatch: "var(--swatch-amber)", releaseId: "rel-co09", initiativeId: "init-3", timeframe: "Jul 2026 → Aug 2026", start: 2, len: 2, effort: 8, value: 85, insights: ["sg-5"],
          description: "SAML 2.0 against the corporate IdP with just-in-time provisioning.",
          subfeatures: [{ id: "sf-saml-1", name: "IdP config UI (Sample)", status: "validation", owner: "Dana Fox" }, { id: "sf-saml-2", name: "Session policies (Sample)", status: "progress", owner: "Sam Ito" }] },
        { id: "ft-device", name: "Device trust checks (Sample)", status: "planned", owner: "Mo Byrd", swatch: "var(--swatch-blue)", releaseId: "rel-co10", initiativeId: "init-3", timeframe: "Aug 2026 → Oct 2026", start: 3, len: 3, effort: 5, value: 70, insights: [],
          description: "Posture checks before sensitive admin actions: managed device, OS version, disk encryption.", subfeatures: [] },
        { id: "ft-login", name: "Unified login page (Sample)", status: "released", owner: "Sam Ito", swatch: "var(--swatch-amber)", releaseId: "rel-co08", initiativeId: "init-3", timeframe: "May 2026 → Jun 2026", start: 0, len: 2, effort: 3, value: 75, insights: [],
          description: "One branded door for every internal tool, with recovery flows IT can actually support.", subfeatures: [] },
      ] },
      { id: "cm-co-desk", name: "Service desk", features: [
        { id: "ft-importer", name: "Ticket importer (Sample)", status: "planned", owner: "Josef Lang", swatch: "var(--swatch-vermilion)", releaseId: "rel-co10", initiativeId: "init-4", timeframe: "Aug 2026 → Sep 2026", start: 3, len: 2, effort: 8, value: 80, insights: ["sg-5"],
          description: "Bring legacy queues into Console with field mapping, a dry-run mode, and a rollback story.",
          subfeatures: [{ id: "sf-imp-1", name: "Field mapping (Sample)", status: "planned", owner: "Josef Lang" }, { id: "sf-imp-2", name: "Dry-run mode (Sample)", status: "planned", owner: "Dana Fox" }] },
        { id: "ft-sunset", name: "Legacy tracker sunset (Sample)", status: "planned", owner: "Dana Fox", swatch: "var(--swatch-vermilion)", releaseId: null, initiativeId: "init-4", timeframe: "Oct 2026 → Nov 2026", start: 5, len: 2, effort: 5, value: 65, insights: ["sg-5"],
          description: "Read-only freeze, export archive, and redirect from the asset tracker everyone loves to hate.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-dispatch", name: "Dispatch (Sample)", owner: "Ana Rios", description: "Job scheduling and assignment for coordinators: from request to the right tech in minutes.",
    components: [
      { id: "cm-di-assign", name: "Assignment", features: [
        { id: "ft-autoassign", name: "Smart auto-assign (Sample)", status: "progress", owner: "Ana Rios", swatch: "var(--swatch-green)", releaseId: null, initiativeId: "init-7", timeframe: "Jun 2026 → Oct 2026", start: 1, len: 5, effort: 13, value: 90, insights: ["sg-8"],
          description: "Rules-first assignment with a suggestion queue; coordinators approve, the system learns.",
          subfeatures: [{ id: "sf-aa-1", name: "Skill matching (Sample)", status: "progress", owner: "Ana Rios" }, { id: "sf-aa-2", name: "Territory rules (Sample)", status: "released", owner: "Marcus Webb" }, { id: "sf-aa-3", name: "Load balancing (Sample)", status: "planned", owner: "Sam Ito" }] },
        { id: "ft-bulk", name: "Bulk reschedule (Sample)", status: "planned", owner: "Ana Rios", swatch: "var(--swatch-green)", releaseId: null, initiativeId: null, timeframe: "Sep 2026 → Oct 2026", start: 4, len: 2, effort: 5, value: 60, insights: [], description: "Storm-day tool: shift a day of jobs with conflict warnings instead of forty drag operations.", subfeatures: [] },
      ] },
      { id: "cm-di-sched", name: "Scheduling", features: [
        { id: "ft-etaboard", name: "Live ETA board (Sample)", status: "validation", owner: "Marcus Webb", swatch: "var(--swatch-sky)", releaseId: null, initiativeId: "init-7", timeframe: "Jun 2026 → Aug 2026", start: 1, len: 3, effort: 8, value: 70, insights: ["sg-8"], description: "Wall-screen view of today's jobs, running late flags, and who's nearest.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-routes", name: "Routes (Sample)", owner: "Ana Rios", description: "Route planning and optimization: less windshield time, more wrench time.",
    components: [
      { id: "cm-ro-plan", name: "Planning", features: [
        { id: "ft-optimizer", name: "Multi-stop optimizer (Sample)", status: "progress", owner: "Ana Rios", swatch: "var(--swatch-green)", releaseId: null, initiativeId: "init-7", timeframe: "Jun 2026 → Sep 2026", start: 1, len: 4, effort: 13, value: 85, insights: [], description: "Day-level route optimization honoring time windows, skills, and parts on the truck.", subfeatures: [] },
        { id: "ft-traffic", name: "Traffic-aware ETAs (Sample)", status: "planned", owner: "Sam Ito", swatch: "var(--swatch-sky)", releaseId: null, initiativeId: null, timeframe: "Sep 2026 → Nov 2026", start: 4, len: 3, effort: 8, value: 65, insights: ["sg-8"], description: "Live traffic feeds adjust promised windows before the customer calls.", subfeatures: [] },
      ] },
      { id: "cm-ro-nav", name: "Navigation", features: [
        { id: "ft-sitenotes", name: "Site access notes (Sample)", status: "released", owner: "Rosa Alvine", swatch: "var(--swatch-teal)", releaseId: "rel-fa42", initiativeId: null, timeframe: "May 2026 → Jun 2026", start: 0, len: 2, effort: 3, value: 55, insights: [], description: "Gate codes, dogs, and dock quirks pinned to the site record, surfaced on arrival.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-telemetry", name: "Telemetry (Sample)", owner: "Sam Ito", description: "Device data pipeline: ingest, health scoring, and alerts for connected field equipment.",
    components: [
      { id: "cm-te-alerts", name: "Alerts", features: [
        { id: "ft-anomaly", name: "Anomaly alerts (Sample)", status: "progress", owner: "Sam Ito", swatch: "var(--swatch-sky)", releaseId: "rel-te21", initiativeId: "init-9", timeframe: "Jun 2026 → Sep 2026", start: 1, len: 4, effort: 8, value: 75, insights: ["sg-9"],
          description: "Baseline-aware alerts that page on drift, not on noise.",
          subfeatures: [{ id: "sf-an-1", name: "Threshold profiles (Sample)", status: "progress", owner: "Sam Ito" }, { id: "sf-an-2", name: "Alert routing (Sample)", status: "planned", owner: "Dana Fox" }] },
        { id: "ft-quiet", name: "Quiet-hours bundling (Sample)", status: "idea", owner: "Sam Ito", swatch: "var(--swatch-violet)", releaseId: null, initiativeId: "init-9", timeframe: "Q4 2026", start: 5, len: 2, effort: 3, value: 50, insights: ["sg-9"], description: "Batch non-critical alerts into a morning digest; only true anomalies page at night.", subfeatures: [] },
      ] },
      { id: "cm-te-ingest", name: "Ingest", features: [
        { id: "ft-health", name: "Device health scores (Sample)", status: "planned", owner: "Sam Ito", swatch: "var(--swatch-blue)", releaseId: "rel-te21", initiativeId: "init-9", timeframe: "Sep 2026 → Nov 2026", start: 4, len: 3, effort: 8, value: 70, insights: [], description: "One 0–100 score per device rolled up from vitals, so triage starts sorted.", subfeatures: [] },
        { id: "ft-coldchain", name: "Cold-chain monitoring (Sample)", status: "idea", owner: "Marcus Webb", swatch: "var(--swatch-teal)", releaseId: null, initiativeId: null, timeframe: "Q4 2026", start: 6, len: 2, effort: 13, value: 45, insights: [], description: "Continuous temperature audit trail for refrigerated transport jobs.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-billing", name: "Billing Hub (Sample)", owner: "Mo Byrd", description: "Invoicing and reconciliation for completed work: accurate, automatic, auditable.",
    components: [
      { id: "cm-bi-recon", name: "Reconciliation", features: [
        { id: "ft-recon", name: "Auto-reconciliation (Sample)", status: "progress", owner: "Mo Byrd", swatch: "var(--swatch-vermilion)", releaseId: null, initiativeId: "init-8", timeframe: "Jun 2026 → Nov 2026", start: 1, len: 6, effort: 13, value: 88, insights: ["sg-10"],
          description: "Match rules pair payments to invoices; humans only see the exceptions.",
          subfeatures: [{ id: "sf-re-1", name: "Match rules (Sample)", status: "progress", owner: "Mo Byrd" }, { id: "sf-re-2", name: "Exception queue (Sample)", status: "planned", owner: "Josef Lang" }] },
        { id: "ft-dispute", name: "Dispute workspace (Sample)", status: "idea", owner: "Mo Byrd", swatch: "var(--swatch-magenta)", releaseId: null, initiativeId: "init-8", timeframe: "Q4 2026", start: 6, len: 2, effort: 8, value: 55, insights: [], description: "Every dispute with its evidence, owner, and clock in one thread.", subfeatures: [] },
      ] },
      { id: "cm-bi-inv", name: "Invoicing", features: [
        { id: "ft-exports", name: "Scheduled exports (Sample)", status: "planned", owner: "Josef Lang", swatch: "var(--swatch-amber)", releaseId: "rel-co10", initiativeId: null, timeframe: "Aug 2026 → Sep 2026", start: 3, len: 2, effort: 5, value: 78, insights: ["sg-3", "sg-10"], description: "Filtered views delivered on a schedule to email or Slack; the Monday chore, deleted.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-portal", name: "Partner Portal (Sample)", owner: "Priya Nair", description: "Self-serve surface for internal requesters: track work, find answers, file signals.",
    components: [
      { id: "cm-po-req", name: "Requests", features: [
        { id: "ft-reqtrack", name: "Request tracker (Sample)", status: "released", owner: "Priya Nair", swatch: "var(--swatch-teal)", releaseId: "rel-co08", initiativeId: null, timeframe: "May 2026 → Jun 2026", start: 0, len: 2, effort: 5, value: 60, insights: [], description: "Status, owner, and next step for every open request — no more \"any update?\" pings.", subfeatures: [] },
        { id: "ft-intake", name: "Signal intake form (Sample)", status: "idea", owner: "Priya Nair", swatch: "var(--swatch-magenta)", releaseId: null, initiativeId: "init-5", timeframe: "Sep 2026 → Oct 2026", start: 4, len: 2, effort: 3, value: 58, insights: ["sg-2"], description: "Structured feedback capture from any team, routed straight into the knowledge base.", subfeatures: [] },
      ] },
      { id: "cm-po-know", name: "Knowledge", features: [
        { id: "ft-psearch", name: "Portal search (Sample)", status: "planned", owner: "Priya Nair", swatch: "var(--swatch-violet)", releaseId: null, initiativeId: "init-6", timeframe: "Aug 2026 → Nov 2026", start: 3, len: 4, effort: 8, value: 82, insights: ["sg-2"], description: "One query across wikis, docs, and tickets with answer cards, not link lists.", subfeatures: [] },
      ] },
    ] },
  { id: "pr-api", name: "Platform API (Sample)", owner: "Sam Ito", description: "Public-internal API surface and webhooks that every Meridian product builds on.",
    components: [
      { id: "cm-api-core", name: "Core API", features: [
        { id: "ft-apiv3", name: "API v3 (Sample)", status: "progress", owner: "Sam Ito", swatch: "var(--swatch-blue)", releaseId: "rel-api3", initiativeId: "init-9", timeframe: "Jun 2026 → Oct 2026", start: 1, len: 5, effort: 13, value: 80, insights: ["sg-11"],
          description: "Cursor pagination, idempotency, and consistent errors — the API the docs pretend v2 is.",
          subfeatures: [{ id: "sf-api-1", name: "Rate limit tiers (Sample)", status: "progress", owner: "Sam Ito" }, { id: "sf-api-2", name: "Idempotency keys (Sample)", status: "validation", owner: "Dana Fox" }] },
        { id: "ft-audit", name: "Audit log stream (Sample)", status: "validation", owner: "Dana Fox", swatch: "var(--swatch-sky)", releaseId: "rel-api3", initiativeId: "init-9", timeframe: "Jul 2026 → Sep 2026", start: 2, len: 3, effort: 5, value: 68, insights: [], description: "Every admin action as a queryable event stream for Security & IT.", subfeatures: [] },
      ] },
      { id: "cm-api-hooks", name: "Webhooks", features: [
        { id: "ft-replay", name: "Webhook replay (Sample)", status: "planned", owner: "Sam Ito", swatch: "var(--swatch-amber)", releaseId: "rel-api3", initiativeId: null, timeframe: "Sep 2026 → Oct 2026", start: 4, len: 2, effort: 5, value: 62, insights: ["sg-11"], description: "Self-serve redelivery with diffing, because \"we missed an event\" shouldn't be a ticket.", subfeatures: [] },
      ] },
    ] },
];

export const RELEASE_GROUPS = [
  { id: "rg-fieldapp", name: "Field App 4.x (Sample Release Group)", releases: [
    { id: "rel-fa42", name: "Field App 4.2 (Sample Release)", state: "released", date: "Jun 12, 2026", progress: 100 },
    { id: "rel-fa43", name: "Field App 4.3 (Sample Release)", state: "progress", date: "Sep 4, 2026", progress: 58 },
    { id: "rel-fa44", name: "Field App 4.4 (Sample Release)", state: "planned", date: "Nov 6, 2026", progress: 0 },
  ] },
  { id: "rg-console", name: "Console 2026 (Sample Release Group)", releases: [
    { id: "rel-co08", name: "Console 2026.08 (Sample Release)", state: "released", date: "Aug 8, 2026", progress: 100 },
    { id: "rel-co09", name: "Console 2026.09 (Sample Release)", state: "progress", date: "Sep 26, 2026", progress: 71 },
    { id: "rel-co10", name: "Console 2026.10 (Sample Release)", state: "planned", date: "Oct 24, 2026", progress: 12 },
  ] },
  { id: "rg-platform", name: "Platform H2 (Sample Release Group)", releases: [
    { id: "rel-api3", name: "API v3 beta (Sample Release)", state: "progress", date: "Oct 15, 2026", progress: 44 },
    { id: "rel-te21", name: "Telemetry 2.1 (Sample Release)", state: "planned", date: "Nov 20, 2026", progress: 8 },
  ] },
];

export const SIGNALS = [
  { id: "sg-1", team: "Field Ops", author: "Marcus Webb", kind: "Call note", time: "8:45 PM", unread: true,
    text: "We love the web app but our field teams are mostly on mobile and the experience there is… not there yet. Most techs give up during setup and fall back to email.",
    summary: "Field teams stall during mobile setup and revert to email; a guided, step-by-step first run would unblock adoption.",
    sources: "From 1 call · Field Ops", linkedId: "ft-setup" },
  { id: "sg-2", team: "Support", author: "Lena Ortiz", kind: "Slack thread", time: "6:12 PM", unread: true,
    text: "Third time this week someone rewrote the same troubleshooting answer. We have it in two wikis and a doc — nobody finds any of them.",
    summary: "Duplicate answers persist across three knowledge stores; discovery, not authoring, is the bottleneck.",
    sources: "From 4 messages · Support", linkedId: "ft-psearch" },
  { id: "sg-3", team: "Sales EU", author: "Tom Keller", kind: "Service ticket", time: "Mon 9:02 AM", unread: false,
    text: "Requesting the weekly pipeline export again. Every Monday I pull the same filtered view and mail it to the region leads.",
    summary: "Weekly manual exports of the same filtered view; scheduled delivery to email would remove the chore.",
    sources: "From 3 tickets · Sales EU", linkedId: "ft-exports" },
  { id: "sg-4", team: "Field Ops", author: "Rosa Alvine", kind: "Survey response", time: "Fri 4:40 PM", unread: false,
    text: "Offline mode. That's it. Basements and rural sites have no coverage and the app is a brick there.",
    summary: "No-coverage sites make the app unusable; offline-first sync is the single most requested capability.",
    sources: "From 9 responses · Field Ops", linkedId: "ft-offline" },
  { id: "sg-5", team: "Internal Systems", author: "Dana Fox", kind: "Email", time: "Thu 11:20 AM", unread: false,
    text: "Legacy asset tracker exports break every time IT rotates certificates. Can Console own this workflow already?",
    summary: "Legacy tracker integration is brittle; migrating the workflow into Console would end recurring breakage.",
    sources: "From 2 emails · Internal Systems", linkedId: "init-4" },
  { id: "sg-6", team: "Field Ops", author: "Marcus Webb", kind: "Call note", time: "Wed 2:15 PM", unread: false,
    text: "The setup checklist helped, but reps still ask which steps matter for their role. Installers don't need the inventory module at all.",
    summary: "Checklist adoption is good; role-based filtering of steps is the next friction point.",
    sources: "From 1 call · Field Ops", linkedId: "ft-setup" },
  { id: "sg-7", team: "Field Ops", author: "Rosa Alvine", kind: "Survey response", time: "Tue 7:58 AM", unread: false,
    text: "Night crew starts blind. Whatever the day shift learned lives in texts and sticky notes until someone re-discovers it at 2 AM.",
    summary: "Shift handoffs lose context; a structured end-of-shift summary would carry blockers forward.",
    sources: "From 5 responses · Field Ops", linkedId: "ft-handoff" },
  { id: "sg-8", team: "Customer Success", author: "Priya Nair", kind: "Slack thread", time: "Mon 3:30 PM", unread: true,
    text: "Coordinators quote 'sometime today' because they don't trust the ETAs. Two regions keep their own spreadsheet of who's actually close.",
    summary: "ETA distrust drives shadow spreadsheets; live location-aware ETAs would restore confidence.",
    sources: "From 6 messages · Customer Success", linkedId: "ft-etaboard" },
  { id: "sg-9", team: "Data & Analytics", author: "Sam Ito", kind: "Email", time: "Thu 9:12 AM", unread: false,
    text: "On-call got paged 14 times last night; 11 were the same flapping sensor. People are starting to mute the channel, which is how real incidents get missed.",
    summary: "Alert fatigue from flapping devices; deduplication and quiet-hours bundling would protect on-call attention.",
    sources: "From 2 emails · Data & Analytics", linkedId: "ft-anomaly" },
  { id: "sg-10", team: "Finance Ops", author: "Mo Byrd", kind: "Service ticket", time: "Fri 5:05 PM", unread: false,
    text: "Reconciliation backlog hits every Friday. Two of us lose the afternoon to matching payments by hand, and month-end is worse.",
    summary: "Manual payment matching consumes Friday afternoons; rules-based auto-reconciliation would cut the backlog.",
    sources: "From 3 tickets · Finance Ops", linkedId: "ft-recon" },
  { id: "sg-11", team: "Internal Systems", author: "Dana Fox", kind: "Slack thread", time: "Wed 10:44 AM", unread: false,
    text: "Integration partners keep asking us to 'just resend' webhook events after their outages. Each request is a manual DB job for us.",
    summary: "Manual webhook redelivery is a recurring toil item; self-serve replay would remove a support queue.",
    sources: "From 4 messages · Internal Systems", linkedId: "ft-replay" },
];

export const FINDINGS = [
  { id: "fd-1", title: "Mobile setup abandonment", strength: "High signal", occurrences: 12, teams: 3, lastSeen: "Today", opportunityId: "op-1",
    statement: "Across calls, surveys, and support threads, new technicians stall in first-run setup and revert to email or phone workflows." },
  { id: "fd-2", title: "Answers exist but aren't found", strength: "High signal", occurrences: 8, teams: 4, lastSeen: "Yesterday", opportunityId: "op-3",
    statement: "The same troubleshooting answers are rewritten across two wikis and a doc archive; discovery is the bottleneck, not authoring." },
  { id: "fd-3", title: "Weekly manual export ritual", strength: "Medium signal", occurrences: 6, teams: 2, lastSeen: "Mon", opportunityId: "op-2",
    statement: "Ops and sales re-export identical filtered views every week and mail them to leads by hand." },
  { id: "fd-4", title: "Offline dead zones brick the app", strength: "High signal", occurrences: 9, teams: 1, lastSeen: "Fri", opportunityId: "op-1",
    statement: "Basements and rural sites have no coverage; without offline-first sync the app is unusable exactly where work happens." },
  { id: "fd-5", title: "Alert fatigue on night shifts", strength: "Medium signal", occurrences: 5, teams: 2, lastSeen: "Thu", opportunityId: "op-4",
    statement: "Flapping sensors page on-call repeatedly; responders mute channels and risk missing true incidents." },
  { id: "fd-6", title: "Friday reconciliation backlog", strength: "Emerging", occurrences: 4, teams: 1, lastSeen: "Fri", opportunityId: null,
    statement: "Finance loses Friday afternoons to hand-matching payments; month-end multiplies the cost." },
];

export const OPPORTUNITIES = [
  { id: "op-1", title: "Guided setup for field teams", strength: "High signal", findings: 12, objectiveId: "obj-1", owner: "Maya Chen", status: "progress",
    statement: "Technicians abandon setup on mobile and revert to email. A guided first-run with progress steps unblocks the largest adoption gap.",
    sources: "12 findings · 3 teams · roadmap gap: onboarding" },
  { id: "op-2", title: "Scheduled report exports", strength: "Medium signal", findings: 6, objectiveId: "obj-2", owner: "Josef Lang", status: "planned",
    statement: "Ops and sales re-export identical filtered views weekly. Scheduled, filtered exports to email or Slack remove a recurring chore.",
    sources: "6 findings · 2 teams · competitive: parity gap" },
  { id: "op-3", title: "One search across tools", strength: "Medium signal", findings: 5, objectiveId: "obj-3", owner: "Priya Nair", status: "planned",
    statement: "Answers exist in three stores but aren't found. A single ask-surface over all knowledge cuts duplicate authoring.",
    sources: "5 findings · 4 teams · strategy: knowledge reuse" },
  { id: "op-4", title: "Quiet-hours alert bundling", strength: "Emerging", findings: 3, objectiveId: "obj-6", owner: "Sam Ito", status: "idea",
    statement: "Non-critical alerts page on-call at night and train responders to mute. Bundling into a morning digest protects attention for true anomalies.",
    sources: "3 findings · 2 teams · reliability guardrail" },
];

export const SKILLS = [
  { id: "sk-1", name: "Summarize entity", enabled: true, desc: "Tiered rollups for any product, objective, or feature.",
    instructions: "## Purpose\nProduce tiered rollups for any entity.\n\n## Behavior\n- Tier 1 containers (products, components, release groups): child-rollup first — **Summary** (1–2 sentences, note child count), then one bullet per child (≤7; cluster themes when more).\n- Tier 2 (objectives, initiatives, features, releases): spec/description first, then offer fan-out.\n- Tier 3 (subfeatures, key results, findings): spec/description only, no children.\n\n## Constraints\n- Never fabricate. Summarize only what's in the content; if it's thin, say so.\n- Every claim cites its source entity.\n- Stay within 1–2 line summary + up to 3 bullets unless asked to expand." },
  { id: "sk-2", name: "Draft spec from signals", enabled: true, desc: "Delivery-ready spec grounded in linked signals.",
    instructions: "## Purpose\nDraft a delivery-ready spec for a feature from its linked signals and strategy context.\n\n## Output\n- Problem (grounded in signals, each cited)\n- Proposal (scoped to the feature's component)\n- Non-goals\n- Open questions\n\n## Constraints\n- Only cite signals actually linked to the entity.\n- If fewer than 2 signals are linked, say the evidence is thin and list what to collect." },
  { id: "sk-3", name: "Weekly opportunity briefing", enabled: true, desc: "Top three evidence-backed problems, every Monday.",
    instructions: "## Purpose\nEvery Monday, surface the top three opportunities from the week's findings.\n\n## Behavior\n- Rank by signal strength × strategy alignment.\n- Each opportunity: statement, evidence line (findings · teams), aligned objective.\n- Flag anything trending down that was previously top-three." },
  { id: "sk-4", name: "Competitive scan", enabled: false, desc: "Watches selected vendors for relevant changes.",
    instructions: "## Purpose\nWatch selected vendors and summarize relevant changes.\n\n## Constraints\n- Internal tool: scan is limited to public changelogs and docs.\n- Route findings to the Knowledge inbox, never directly to boards." },
  { id: "sk-5", name: "Release notes drafting", enabled: false, desc: "Drafts internal release notes from shipped features.",
    instructions: "## Purpose\nDraft internal release notes from the features shipped in a release.\n\n## Behavior\n- Group by product, lead with the user-visible change.\n- Link each line to its feature and spec.\n- Tone: matter-of-fact, no marketing." },
];

export const AUTOMATIONS = [
  { id: "au-1", name: "Monday adoption digest", freq: "Weekly · Mon 9:00 AM", skill: "Summarize entity", output: "Field Platform space", active: true },
  { id: "au-2", name: "Signal triage", freq: "Hourly", skill: "Draft spec from signals", output: "Inbox", active: true },
  { id: "au-3", name: "Friday release notes", freq: "Weekly · Fri 3:00 PM", skill: "Release notes drafting", output: "Personal section", active: false },
];

export const RECENT_CHATS = ["Spec for Guided first run", "Feedback analysis · Field Ops", "Why is obj-2 at risk?"];

export const ASK_ANSWERS = [
  { match: ["adoption", "field app", "onboarding", "setup"], answer: "Field App adoption is at 3,100 weekly active technicians (62% of the 5,000 target). The biggest drag is first-run setup — 12 findings across 3 teams show technicians stalling and reverting to email. Guided first run ships in Field App 4.3 (Sep 4).", sources: "From 12 findings · Objectives: Increase Field App adoption" },
  { match: ["export", "report", "monday"], answer: "Scheduled exports is planned for Console 2026.10 (Oct 24). Evidence: 6 findings across Sales EU and Finance Ops describe a weekly manual export ritual. Aligned to Consolidate tooling onto Console.", sources: "From 6 findings · 2 teams" },
  { match: ["offline", "sync", "coverage"], answer: "Offline-first sync is in progress (58% through Field App 4.3). 9 survey responses from Field Ops call no-coverage sites the top blocker; conflict resolution and delta sync are mid-build, media queue is next.", sources: "From 9 responses · Field Ops" },
  { match: [], answer: "Across this quarter: 6 objectives (4 on track, 2 at risk), 9 initiatives, and 26 features in flight. The freshest risks are Console migration wave 2 (blocked on ticket importer) and Friday reconciliation backlog (4 occurrences).", sources: "From 11 signals · 6 findings · this workspace" },
];
