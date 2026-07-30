// Attest — shared session store (business logic only; no styling)
(function () {
  if (window.__attest) return;

  var PROGRAMS = [
    { id: "gray-talon", code: "PRG-014", name: "Gray Talon TUAS", service: "U.S. Army", platform: "Group 4 tactical UAS",
      triad: "M-M-H", il: "IL5", controls: 612, tailored: 612, implemented: 471, partial: 96, planned: 45,
      reqs: 148, reqAllocated: 141, reqGap: 7, phase: "EMD", health: "at-risk", swatch: "var(--swatch-green)", updated: "29 Jul",
      sctmRev: "Rev C", spRev: "Rev B", due: "14 Sep 2026", cdrl: "A012 / A014", owner: "M. Okonjo", assessor: "AFLCMC/HNCP" },
    { id: "trident-reach", code: "PRG-021", name: "Trident Reach ASW Suite", service: "U.S. Navy", platform: "Shipboard mission system",
      triad: "M-H-H", il: "IL6", controls: 688, tailored: 688, implemented: 402, partial: 174, planned: 112,
      reqs: 206, reqAllocated: 178, reqGap: 28, phase: "EMD", health: "at-risk", swatch: "var(--swatch-blue)", updated: "28 Jul",
      sctmRev: "Rev F", spRev: "Rev E", due: "02 Nov 2026", cdrl: "B003", owner: "K. Reyes", assessor: "NAVWAR 5.0" },
    { id: "orbital-sentry", code: "PRG-007", name: "Orbital Sentry GEO Payload", service: "U.S. Space Force", platform: "GEO hosted payload",
      triad: "H-H-M", il: "IL6", controls: 741, tailored: 741, implemented: 655, partial: 61, planned: 25,
      reqs: 174, reqAllocated: 174, reqGap: 0, phase: "Production", health: "on-track", swatch: "var(--swatch-violet)", updated: "27 Jul",
      sctmRev: "Rev H", spRev: "Rev H", due: "30 Aug 2026", cdrl: "C101 / C104", owner: "D. Vasquez", assessor: "SSC/SZG" },
    { id: "talon-vector", code: "PRG-033", name: "Talon Vector ECU/FCC", service: "U.S. Air Force", platform: "Airborne flight controls",
      triad: "M-M-H", il: "IL5", controls: 574, tailored: 574, implemented: 318, partial: 141, planned: 115,
      reqs: 121, reqAllocated: 96, reqGap: 25, phase: "TMRR", health: "off-track", swatch: "var(--swatch-sky)", updated: "29 Jul",
      sctmRev: "Rev B", spRev: "Rev A", due: "19 Dec 2026", cdrl: "A008", owner: "S. Whitfield", assessor: "AFLCMC/EZ" },
    { id: "expeditionary-node", code: "PRG-045", name: "Expeditionary Node Kit", service: "U.S. Marine Corps", platform: "Tactical edge compute",
      triad: "M-M-M", il: "IL4", controls: 498, tailored: 498, implemented: 466, partial: 22, planned: 10,
      reqs: 96, reqAllocated: 94, reqGap: 2, phase: "Production", health: "on-track", swatch: "var(--swatch-vermilion)", updated: "24 Jul",
      sctmRev: "Rev D", spRev: "Rev D", due: "07 Oct 2026", cdrl: "D021", owner: "J. Park", assessor: "MCSC PfM IA" }
  ];

  var state = {
    view: "portfolio",
    rail: "programs",
    programId: "gray-talon",
    // portfolio table
    portScope: "all",
    // requirements register
    reqSel: "SRS-3.4.9",
    reqFilter: "all",
    reqPanel: 1,
    reqTab: "overview",
    // SCTM
    sctmSel: "SC-13",
    sctmEdits: {},
    sctmEditing: null,
    sctmDrawer: { "SC-13": 1 },
    panelOpen: true,
    controlsOpen: false,
    sctmTab: "trace",
    layout: "grid",
    groupBy: "family",
    density: "standard",
    cols: { req: 1, sys: 1, status: 1, ev: 1, sp: 1, owner: 1 },
    filters: { status: null, owner: null, noEvidence: false, staleOnly: false },
    filterMenu: null,
    // change control
    queue: { "CHG-118": "open", "CHG-119": "open", "CHG-120": "open" },
    openChange: "CHG-118",
    // staleness keyed by control id / SP block id
    stale: { "SC-12": 1, "SC-13": 1, "IA-7": 1, "sp-b3": 1, "sp-b4": 1, "sp-b6": 1 },
    notif: 4,
    toast: null,
    // baseline builder overlays
    overlays: { cnssi: true, sparta: false, attack: true, ics: true, cmmc: false, do326: true, iec: false, csa: true, cdrl: true },
    triad: { c: "M", i: "M", a: "H" },
    // new-program wizard
    wizard: {
      step: 1,
      name: "",
      code: "PRG-052",
      service: "U.S. Army",
      platform: "Rotary-wing mission computer",
      owner: "M. Okonjo",
      assessor: "AFLCMC/HNCP",
      il: "IL5",
      triad: { c: "M", i: "M", a: "H" },
      families: { PE: 1, MA: 1, PS: 1 },
      overlays: { cnssi: true, do326: true, attack: true, ics: false, sparta: false, iec: false, cmmc: true, csa: true, cdrl: true },
      docs: { a012: 1, a014: 1, sow: 1, icd: 0 },
      parsed: false,
      parsing: false
    },
    // systems
    wbs: { "1.0": 1, "1.1": 1, "1.1.5": 1, "1.1.4": 0, "1.1.1": 0, "1.1.2": 0, "1.1.3": 0, "1.1.6": 0, "1.2": 0, "1.3": 0, "1.4": 0 },
    wbsSel: "1.1.5.3",
    wbsFilter: null,
    wbsEdits: {},
    wbsCtlOff: {},
    wbsRenaming: false,
    // SP editor
    spBlock: null,
    slashOpen: false,
    spSection: "4.3",
    // library
    libFamily: "SC",
    libCatalog: "800-53",
    libCatOpen: 1,
    libGroups: { "800-53:SC": 1 },
    libGroupBy: "native",
    libCols: { levels: 1, map: 1, programs: 1, bp: 1 },
    libDensity: "standard",
    libOnlyOverlay: false,
    libOnlyBp: false,
    // sources
    syncing: null,
    srcSel: null,
    // assessment
    assessSel: "SC-13",
    assessFilter: "all",
    // findings and POA&M
    poamSel: "FND-0204",
    poamFilter: "all",
    // scans, STIGs, SBOM
    scanTab: "scans",
    scanPromoted: 0,
    // authorization
    authzStep: "assess",
    fwOff: {},
    // program protection
    protSel: "CPI-001",
    protFilter: null,
    // cyber survivability
    csaSel: "csa06",
    threadSel: "maint",
    // reviews and sign-off
    threadsResolved: {},
    rfiClosed: {},
    spSigned: 0,
    // deliverable packages
    pkgSel: "cdrl"
  };

  var subs = new Set();
  function emit() { subs.forEach(function (f) { f(); }); }

  var VIEW_RAIL = { portfolio: "programs", newprog: "programs", home: "programs", reqs: "programs",
    baseline: "programs", sctm: "programs", sp: "programs",
    docs: "programs", impact: "programs", inbox: "programs", systems: "systems", library: "library", sources: "sources",
    assess: "programs", poam: "programs", scans: "programs", authz: "programs",
    protect: "programs", survive: "programs", reviews: "programs", deliver: "programs" };

  var api = {
    state: state,
    programs: PROGRAMS,
    sub: function (f) { subs.add(f); return function () { subs.delete(f); }; },
    set: function (patch) { Object.assign(state, patch); emit(); },
    prog: function () { return PROGRAMS.find(function (p) { return p.id === state.programId; }) || PROGRAMS[0]; },
    go: function (view) { state.view = view; state.rail = VIEW_RAIL[view] || state.rail; emit(); },
    goRail: function (rail) {
      state.rail = rail;
      state.view = rail === "systems" ? "systems" : rail === "library" ? "library" : rail === "sources" ? "sources" : "portfolio";
      emit();
    },
    selectProgram: function (id) { state.programId = id; state.view = "home"; state.rail = "programs"; emit(); },
    isStale: function (id) { return !!state.stale[id]; },
    toggleOverlay: function (k) { state.overlays[k] = !state.overlays[k]; emit(); },
    setTriad: function (k, v) { state.triad[k] = v; emit(); },
    toggleWbs: function (k) { state.wbs[k] = state.wbs[k] ? 0 : 1; emit(); },
    setWbsFilter: function (f) {
      state.wbsFilter = state.wbsFilter === f ? null : f;
      state.view = "systems"; state.rail = "systems"; emit();
    },
    editWbs: function (id, key, val) {
      var e = state.wbsEdits[id] || (state.wbsEdits[id] = {});
      e[key] = val; emit();
    },
    toggleWbsCtl: function (id, ctl) {
      var k = id + "|" + ctl;
      state.wbsCtlOff[k] = state.wbsCtlOff[k] ? 0 : 1; emit();
    },
    setLibCatalog: function (id) { state.libCatalog = id; state.view = "library"; state.rail = "library"; emit(); },
    toggleLibGroup: function (k) { state.libGroups[k] = state.libGroups[k] ? 0 : 1; emit(); },
    toggleLibCol: function (k) { state.libCols[k] = state.libCols[k] ? 0 : 1; emit(); },
    selectSource: function (name) { state.srcSel = name; state.view = "sources"; state.rail = "sources"; emit(); },
    toggleCol: function (k) { state.cols[k] = state.cols[k] ? 0 : 1; emit(); },
    editSctm: function (id, key, val) {
      var e = state.sctmEdits[id] || (state.sctmEdits[id] = {});
      e[key] = val; emit();
    },
    setSctmEditing: function (k) { state.sctmEditing = k; emit(); },
    toggleSctmDrawer: function (id) { state.sctmDrawer[id] = state.sctmDrawer[id] ? 0 : 1; emit(); },
    setFilter: function (k, v) { state.filters[k] = v; state.filterMenu = null; emit(); },
    clearFilters: function () { state.filters = { status: null, owner: null, noEvidence: false, staleOnly: false }; emit(); },
    selectReq: function (id) { state.reqSel = id; emit(); },
    // wizard
    wiz: function (patch) { Object.assign(state.wizard, patch); emit(); },
    wizStep: function (n) { state.wizard.step = Math.max(1, Math.min(4, n)); emit(); },
    wizTriad: function (k, v) { state.wizard.triad[k] = v; emit(); },
    wizOverlay: function (k) { state.wizard.overlays[k] = !state.wizard.overlays[k]; emit(); },
    wizFamily: function (k) { state.wizard.families[k] = state.wizard.families[k] ? 0 : 1; emit(); },
    wizDoc: function (k) { state.wizard.docs[k] = state.wizard.docs[k] ? 0 : 1; state.wizard.parsed = false; emit(); },
    wizParse: function () {
      state.wizard.parsing = true; emit();
      setTimeout(function () {
        state.wizard.parsing = false; state.wizard.parsed = true; emit();
        api.toast({ tone: "ai", title: "163 security requirements extracted", desc: "Cerebro allocated 149 to catalog controls. 8 need a local control, 6 are unallocated." });
      }, 1500);
    },
    createProgram: function (summary) {
      var w = state.wizard;
      var id = "prg-" + (w.code || "PRG-052").toLowerCase();
      PROGRAMS.push({
        id: id, code: w.code, name: w.name || "Untitled program", service: w.service, platform: w.platform,
        triad: w.triad.c + "-" + w.triad.i + "-" + w.triad.a, il: w.il,
        controls: summary.total, tailored: summary.total, implemented: 0, partial: 0, planned: summary.total,
        reqs: summary.reqs, reqAllocated: summary.allocated, reqGap: summary.gap,
        phase: "TMRR", health: "on-track", swatch: "var(--swatch-teal)", updated: "29 Jul",
        sctmRev: "Rev A", spRev: "Rev A", due: "TBD", cdrl: "A012 / A014", owner: w.owner, assessor: w.assessor
      });
      state.programId = id; state.view = "home"; state.rail = "programs"; emit();
      api.toast({ tone: "success", title: (w.name || "Program") + " created", desc: "SCTM Rev A and Security plan Rev A generated with " + summary.total + " controls and " + summary.reqs + " requirements traced." });
    },
    toast: function (t) {
      state.toast = t; emit();
      clearTimeout(api._tt);
      api._tt = setTimeout(function () { state.toast = null; emit(); }, 4200);
    },
    // Accepting CHG-118 clears crypto-module staleness across SCTM + SP
    accept: function (id) {
      state.queue[id] = "accepted";
      if (id === "CHG-118") { delete state.stale["SC-12"]; delete state.stale["SC-13"]; delete state.stale["IA-7"]; delete state.stale["sp-b3"]; delete state.stale["sp-b4"]; delete state.stale["sp-b6"]; }
      state.notif = Math.max(0, state.notif - 1);
      api.toast({ tone: "success", title: id + " accepted", desc: "SCTM Rev C and Security plan §4.3 updated. 3 controls cleared." });
    },
    reject: function (id) {
      state.queue[id] = "rejected";
      state.notif = Math.max(0, state.notif - 1);
      api.toast({ tone: "default", title: id + " rejected", desc: "Source owner notified in Confluence thread." });
    },
    openChange: function (id) { state.openChange = id; state.view = "impact"; state.rail = "programs"; emit(); },
    sync: function (name) {
      state.syncing = name; emit();
      setTimeout(function () { state.syncing = null; api.toast({ tone: "success", title: name + " synced", desc: "No new upstream changes since 07:12." }); }, 1400);
    }
  };

  window.__attest = api;
})();
