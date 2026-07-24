/* @ds-bundle: {"format":4,"namespace":"CerebroDesignSystem_d5fb9b","components":[{"name":"AISummary","sourcePath":"components/ai/AISummary.jsx"},{"name":"AskBar","sourcePath":"components/ai/AskBar.jsx"},{"name":"KanbanCard","sourcePath":"components/boards/KanbanCard.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Checkbox","sourcePath":"components/core/Checkbox.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"Radio","sourcePath":"components/core/Radio.jsx"},{"name":"SegmentedControl","sourcePath":"components/core/SegmentedControl.jsx"},{"name":"Select","sourcePath":"components/core/Select.jsx"},{"name":"Switch","sourcePath":"components/core/Switch.jsx"},{"name":"Avatar","sourcePath":"components/display/Avatar.jsx"},{"name":"AvatarGroup","sourcePath":"components/display/Avatar.jsx"},{"name":"Badge","sourcePath":"components/display/Badge.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"EntityIcon","sourcePath":"components/display/EntityIcon.jsx"},{"name":"HealthChip","sourcePath":"components/display/HealthChip.jsx"},{"name":"ProgressBar","sourcePath":"components/display/ProgressBar.jsx"},{"name":"StatusFlag","sourcePath":"components/display/StatusFlag.jsx"},{"name":"Tag","sourcePath":"components/display/Tag.jsx"},{"name":"Dialog","sourcePath":"components/feedback/Dialog.jsx"},{"name":"EmptyState","sourcePath":"components/feedback/EmptyState.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"FilterChip","sourcePath":"components/navigation/FilterChip.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"AgentHome","sourcePath":"ui_kits/cerebro/AgentHome.jsx"},{"name":"NAV","sourcePath":"ui_kits/cerebro/AppShell.jsx"},{"name":"AppShell","sourcePath":"ui_kits/cerebro/AppShell.jsx"},{"name":"BoardHeader","sourcePath":"ui_kits/cerebro/BoardChrome.jsx"},{"name":"DefaultChips","sourcePath":"ui_kits/cerebro/BoardChrome.jsx"},{"name":"BoardControls","sourcePath":"ui_kits/cerebro/BoardControls.jsx"},{"name":"CerebroApp","sourcePath":"ui_kits/cerebro/CerebroApp.jsx"},{"name":"DeliveryBoard","sourcePath":"ui_kits/cerebro/DeliveryBoard.jsx"},{"name":"DetailPanel","sourcePath":"ui_kits/cerebro/DetailPanel.jsx"},{"name":"KnowledgeView","sourcePath":"ui_kits/cerebro/KnowledgeView.jsx"},{"name":"OkrBoard","sourcePath":"ui_kits/cerebro/OkrBoard.jsx"},{"name":"RoadmapView","sourcePath":"ui_kits/cerebro/RoadmapView.jsx"},{"name":"PEOPLE","sourcePath":"ui_kits/cerebro/data.js"},{"name":"OBJECTIVES","sourcePath":"ui_kits/cerebro/data.js"},{"name":"INITIATIVES","sourcePath":"ui_kits/cerebro/data.js"},{"name":"MONTHS","sourcePath":"ui_kits/cerebro/data.js"},{"name":"DELIVERY","sourcePath":"ui_kits/cerebro/data.js"},{"name":"SIGNALS","sourcePath":"ui_kits/cerebro/data.js"},{"name":"OPPORTUNITIES","sourcePath":"ui_kits/cerebro/data.js"},{"name":"SKILLS","sourcePath":"ui_kits/cerebro/data.js"},{"name":"AUTOMATIONS","sourcePath":"ui_kits/cerebro/data.js"}],"sourceHashes":{"components/ai/AISummary.jsx":"7b3bacf78579","components/ai/AskBar.jsx":"738c1578bcdd","components/boards/KanbanCard.jsx":"5a85e1a1817f","components/core/Button.jsx":"d314b162778f","components/core/Checkbox.jsx":"51e63038ff93","components/core/Icon.jsx":"5db72b95f6cc","components/core/IconButton.jsx":"f922db1d021a","components/core/Input.jsx":"9ca4683a3b20","components/core/Radio.jsx":"174a2a9c2bfe","components/core/SegmentedControl.jsx":"47258e3782db","components/core/Select.jsx":"da9703b03794","components/core/Switch.jsx":"4bdf092c9be7","components/display/Avatar.jsx":"995458441b3e","components/display/Badge.jsx":"6fd5aef15ad9","components/display/Card.jsx":"b1c432303377","components/display/EntityIcon.jsx":"bb0c27fdb855","components/display/HealthChip.jsx":"c4b8ccaf9b2d","components/display/ProgressBar.jsx":"bdb4f2177ae1","components/display/StatusFlag.jsx":"93816c18b6e8","components/display/Tag.jsx":"279375deeaad","components/feedback/Dialog.jsx":"78e4ad6d0d80","components/feedback/EmptyState.jsx":"519bad51fdf0","components/feedback/Toast.jsx":"5476a1630dda","components/feedback/Tooltip.jsx":"61e26c044dc4","components/navigation/FilterChip.jsx":"f7214a7f091e","components/navigation/Tabs.jsx":"0522ad7f6741","ui_kits/cerebro/AgentHome.jsx":"ab14c554e442","ui_kits/cerebro/AppShell.jsx":"57ad435c289c","ui_kits/cerebro/BoardChrome.jsx":"af5c16668b24","ui_kits/cerebro/BoardControls.jsx":"813cfa43de91","ui_kits/cerebro/CerebroApp.jsx":"b136d9f248b6","ui_kits/cerebro/DeliveryBoard.jsx":"5204f4e8ebd1","ui_kits/cerebro/DetailPanel.jsx":"d761625cf928","ui_kits/cerebro/KnowledgeView.jsx":"e8aedf4d4cf2","ui_kits/cerebro/OkrBoard.jsx":"31fd207b9704","ui_kits/cerebro/RoadmapView.jsx":"687d5f08bd3f","ui_kits/cerebro/data.js":"f11f10c7ba45"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.CerebroDesignSystem_d5fb9b = window.CerebroDesignSystem_d5fb9b || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Checkbox.jsx
try { (() => {
const css = `
.cb-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm);color:var(--text-primary);user-select:none}
.cb-check input{position:absolute;opacity:0;width:0;height:0}
.cb-check .cb-box{width:16px;height:16px;border-radius:var(--r-xs);border:1px solid var(--n-300);background:var(--n-0);display:inline-flex;align-items:center;justify-content:center;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);flex:none}
.cb-check:hover .cb-box{border-color:var(--n-400)}
.cb-check input:focus-visible+.cb-box{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-check-on .cb-box{background:var(--accent);border-color:var(--accent)}
.cb-check-disabled{opacity:.45;cursor:not-allowed}`;
if (typeof document !== "undefined" && !document.getElementById("cb-check-css")) {
  const t = document.createElement("style");
  t.id = "cb-check-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: `cb-check ${checked || indeterminate ? "cb-check-on" : ""} ${disabled ? "cb-check-disabled" : ""} ${className}`,
    style: style
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!checked,
    disabled: disabled,
    onChange: e => onChange && onChange(e.target.checked)
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-box"
  }, indeterminate ? /*#__PURE__*/React.createElement("svg", {
    width: "10",
    height: "10",
    viewBox: "0 0 10 10"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2 5h6",
    stroke: "#fff",
    strokeWidth: "2",
    strokeLinecap: "round"
  })) : checked ? /*#__PURE__*/React.createElement("svg", {
    width: "10",
    height: "10",
    viewBox: "0 0 10 10"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1.5 5.2l2.4 2.4 4.6-5",
    stroke: "#fff",
    strokeWidth: "2",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })) : null), label ? /*#__PURE__*/React.createElement("span", null, label) : null);
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
const CDN = "https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js";
function loadLucide() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.lucide) return Promise.resolve(window.lucide);
  if (!window.__cbLucideP) {
    window.__cbLucideP = new Promise(res => {
      const s = document.createElement("script");
      s.src = CDN;
      s.onload = () => res(window.lucide);
      s.onerror = () => res(null);
      document.head.appendChild(s);
    });
  }
  return window.__cbLucideP;
}
const pascal = n => String(n).split("-").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join("");
function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  color,
  style,
  className
}) {
  const [, force] = React.useReducer(x => x + 1, 0);
  const lib = typeof window !== "undefined" ? window.lucide : null;
  React.useEffect(() => {
    if (!lib) loadLucide().then(() => force());
  }, [lib]);
  const raw = lib && lib.icons ? lib.icons[pascal(name)] : null;
  const kids = Array.isArray(raw) ? raw.length === 3 && Array.isArray(raw[2]) ? raw[2] : raw : null;
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: className,
    style: {
      flex: "none",
      display: "inline-block",
      verticalAlign: "middle",
      color,
      ...style
    },
    "aria-hidden": "true"
  }, kids ? kids.map((k, i) => Array.isArray(k) ? React.createElement(k[0], {
    ...k[1],
    key: i
  }) : null) : null);
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/ai/AISummary.jsx
try { (() => {
function AISummary({
  title = "AI summary",
  children,
  sources,
  onRegenerate,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: className,
    style: {
      background: "var(--surface-ai)",
      border: "1px solid var(--synapse-200)",
      borderRadius: "var(--r-lg)",
      padding: "12px 14px",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "sparkles",
    size: 13,
    color: "var(--synapse-500)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      fontWeight: 600,
      color: "var(--text-ai)"
    }
  }, title), onRegenerate ? /*#__PURE__*/React.createElement("button", {
    onClick: onRegenerate,
    title: "Regenerate",
    style: {
      marginLeft: "auto",
      border: "none",
      background: "none",
      padding: 2,
      color: "var(--synapse-400)",
      cursor: "pointer",
      display: "inline-flex",
      borderRadius: 4
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "refresh-cw",
    size: 12
  })) : null), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-xs)",
      lineHeight: "18px",
      color: "var(--n-700)"
    }
  }, children), sources ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: "var(--text-2xs)",
      color: "var(--synapse-600)"
    }
  }, sources) : null);
}
Object.assign(__ds_scope, { AISummary });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/ai/AISummary.jsx", error: String((e && e.message) || e) }); }

// components/ai/AskBar.jsx
try { (() => {
const css = `
.cb-ask{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-lg);cursor:text;transition:border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)}
.cb-ask:hover{border-color:var(--n-400)}
.cb-ask:focus-within{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-ask input{border:none;outline:none;background:transparent;flex:1;min-width:0;font-family:var(--font-ui);font-size:var(--text-sm);color:var(--text-primary)}
.cb-ask input::placeholder{color:var(--n-500)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ask-css")) {
  const t = document.createElement("style");
  t.id = "cb-ask-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function AskBar({
  placeholder = "Search or ask Cerebro",
  value,
  onChange,
  onSubmit,
  width = 520,
  style,
  className = ""
}) {
  const [inner, setInner] = React.useState("");
  const v = value != null ? value : inner;
  return /*#__PURE__*/React.createElement("div", {
    className: `cb-ask ${className}`,
    style: {
      width,
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "sparkles",
    size: 15,
    color: "var(--synapse-500)"
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: placeholder,
    value: v,
    onChange: e => {
      onChange ? onChange(e) : setInner(e.target.value);
    },
    onKeyDown: e => {
      if (e.key === "Enter" && onSubmit) onSubmit(v);
    }
  }), /*#__PURE__*/React.createElement("kbd", null, "\u2318K"));
}
Object.assign(__ds_scope, { AskBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/ai/AskBar.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
const css = `
.cb-btn{font-family:var(--font-ui);font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:var(--r-md);border:1px solid transparent;cursor:pointer;white-space:nowrap;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);outline:none}
.cb-btn:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-btn[disabled]{cursor:not-allowed;opacity:.45}
.cb-btn-md{height:var(--control-h);padding:0 12px;font-size:var(--text-sm)}
.cb-btn-sm{height:var(--control-h-sm);padding:0 10px;font-size:var(--text-xs)}
.cb-btn-lg{height:var(--control-h-lg);padding:0 16px;font-size:var(--text-md)}
.cb-btn-primary{background:var(--accent);color:#fff}
.cb-btn-primary:hover:not([disabled]){background:var(--accent-hover)}
.cb-btn-primary:active:not([disabled]){background:var(--accent-press)}
.cb-btn-secondary{background:var(--n-0);color:var(--n-800);border-color:var(--n-300)}
.cb-btn-secondary:hover:not([disabled]){background:var(--n-50)}
.cb-btn-secondary:active:not([disabled]){background:var(--n-100)}
.cb-btn-ghost{background:transparent;color:var(--n-600)}
.cb-btn-ghost:hover:not([disabled]){background:var(--n-50);color:var(--n-800)}
.cb-btn-ghost:active:not([disabled]){background:var(--n-100)}
.cb-btn-danger{background:var(--danger-500);color:#fff}
.cb-btn-danger:hover:not([disabled]){background:var(--danger-600)}
.cb-btn-danger:active:not([disabled]){background:var(--danger-700)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-btn-css")) {
  const t = document.createElement("style");
  t.id = "cb-btn-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  fullWidth,
  disabled,
  onClick,
  type = "button",
  style,
  className = ""
}) {
  const iconSize = size === "sm" ? 14 : 16;
  return /*#__PURE__*/React.createElement("button", {
    type: type,
    disabled: disabled,
    onClick: onClick,
    className: `cb-btn cb-btn-${size} cb-btn-${variant} ${className}`,
    style: {
      width: fullWidth ? "100%" : undefined,
      ...style
    }
  }, icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: iconSize
  }) : null, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
const css = `
.cb-ibtn{display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-sm);border:1px solid transparent;background:transparent;color:var(--n-600);cursor:pointer;transition:background var(--dur-fast) var(--ease-out);outline:none;padding:0}
.cb-ibtn:hover:not([disabled]){background:var(--n-100);color:var(--n-800)}
.cb-ibtn:active:not([disabled]){background:var(--n-200)}
.cb-ibtn:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-ibtn[disabled]{opacity:.45;cursor:not-allowed}
.cb-ibtn-outline{border-color:var(--n-300);background:var(--n-0)}
.cb-ibtn-outline:hover:not([disabled]){background:var(--n-50)}
.cb-ibtn-active{background:var(--surface-selected);color:var(--cortex-600)}
.cb-ibtn-active:hover:not([disabled]){background:var(--cortex-100);color:var(--cortex-700)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ibtn-css")) {
  const t = document.createElement("style");
  t.id = "cb-ibtn-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  active,
  disabled,
  onClick,
  style,
  className = ""
}) {
  const px = size === "sm" ? 24 : size === "lg" ? 32 : 28;
  const ic = size === "sm" ? 14 : 16;
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: label,
    "aria-label": label,
    disabled: disabled,
    onClick: onClick,
    className: `cb-ibtn ${variant === "outline" ? "cb-ibtn-outline" : ""} ${active ? "cb-ibtn-active" : ""} ${className}`,
    style: {
      width: px,
      height: px,
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: ic
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
const css = `
.cb-input{display:inline-flex;align-items:center;gap:8px;background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-md);padding:0 10px;transition:border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out);color:var(--n-500)}
.cb-input:hover{border-color:var(--n-400)}
.cb-input:focus-within{border-color:var(--border-focus);box-shadow:var(--ring);color:var(--n-600)}
.cb-input input{border:none;outline:none;background:transparent;font-family:var(--font-ui);font-size:var(--text-sm);color:var(--text-primary);flex:1;min-width:0;padding:0;height:100%}
.cb-input input::placeholder{color:var(--text-disabled)}
.cb-input-disabled{background:var(--n-50);pointer-events:none}
.cb-input-disabled input{color:var(--text-disabled)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-input-css")) {
  const t = document.createElement("style");
  t.id = "cb-input-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Input({
  icon,
  placeholder,
  value,
  onChange,
  onKeyDown,
  suffix,
  size = "md",
  disabled,
  autoFocus,
  width,
  style,
  className = ""
}) {
  const h = size === "sm" ? "var(--control-h-sm)" : size === "lg" ? "var(--control-h-lg)" : "var(--control-h)";
  return /*#__PURE__*/React.createElement("span", {
    className: `cb-input ${disabled ? "cb-input-disabled" : ""} ${className}`,
    style: {
      height: h,
      width,
      ...style
    }
  }, icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === "sm" ? 14 : 16
  }) : null, /*#__PURE__*/React.createElement("input", {
    placeholder: placeholder,
    value: value,
    onChange: onChange,
    onKeyDown: onKeyDown,
    disabled: disabled,
    autoFocus: autoFocus
  }), suffix || null);
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/Radio.jsx
try { (() => {
const css = `
.cb-radio{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm);color:var(--text-primary);user-select:none}
.cb-radio input{position:absolute;opacity:0;width:0;height:0}
.cb-radio .cb-dot{width:16px;height:16px;border-radius:50%;border:1px solid var(--n-300);background:var(--n-0);display:inline-flex;align-items:center;justify-content:center;transition:border-color var(--dur-fast) var(--ease-out);flex:none}
.cb-radio:hover .cb-dot{border-color:var(--n-400)}
.cb-radio input:focus-visible+.cb-dot{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-radio-on .cb-dot{border:5px solid var(--accent)}
.cb-radio-disabled{opacity:.45;cursor:not-allowed}`;
if (typeof document !== "undefined" && !document.getElementById("cb-radio-css")) {
  const t = document.createElement("style");
  t.id = "cb-radio-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Radio({
  checked,
  onChange,
  label,
  name,
  disabled,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: `cb-radio ${checked ? "cb-radio-on" : ""} ${disabled ? "cb-radio-disabled" : ""} ${className}`,
    style: style
  }, /*#__PURE__*/React.createElement("input", {
    type: "radio",
    name: name,
    checked: !!checked,
    disabled: disabled,
    onChange: () => onChange && onChange(true)
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-dot"
  }), label ? /*#__PURE__*/React.createElement("span", null, label) : null);
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Radio.jsx", error: String((e && e.message) || e) }); }

// components/core/SegmentedControl.jsx
try { (() => {
const css = `
.cb-seg{display:inline-flex;background:var(--n-100);border-radius:var(--r-md);padding:2px;gap:2px}
.cb-seg button{font-family:var(--font-ui);font-size:var(--text-xs);font-weight:500;color:var(--n-600);background:transparent;border:none;border-radius:var(--r-sm);height:24px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:background var(--dur-fast) var(--ease-out);outline:none;white-space:nowrap}
.cb-seg button:hover{color:var(--n-800)}
.cb-seg button:focus-visible{box-shadow:var(--ring)}
.cb-seg .cb-seg-on{background:var(--n-0);color:var(--n-900);box-shadow:var(--shadow-xs)}
.cb-seg-md button{height:28px;font-size:var(--text-sm);padding:0 12px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-seg-css")) {
  const t = document.createElement("style");
  t.id = "cb-seg-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "sm",
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `cb-seg ${size === "md" ? "cb-seg-md" : ""} ${className}`,
    style: style,
    role: "tablist"
  }, options.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    className: o.value === value ? "cb-seg-on" : "",
    onClick: () => onChange && onChange(o.value)
  }, o.icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: o.icon,
    size: 14
  }) : null, o.label)));
}
Object.assign(__ds_scope, { SegmentedControl });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SegmentedControl.jsx", error: String((e && e.message) || e) }); }

// components/core/Select.jsx
try { (() => {
const css = `
.cb-select{position:relative;display:inline-flex;align-items:center}
.cb-select select{appearance:none;-webkit-appearance:none;font-family:var(--font-ui);font-size:var(--text-sm);color:var(--text-primary);background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-md);padding:0 28px 0 10px;outline:none;cursor:pointer;width:100%;transition:border-color var(--dur-fast) var(--ease-out)}
.cb-select select:hover{background:var(--n-50)}
.cb-select select:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-select select:disabled{background:var(--n-50);color:var(--text-disabled);cursor:not-allowed}
.cb-select .cb-select-chev{position:absolute;right:8px;pointer-events:none;color:var(--n-500)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-select-css")) {
  const t = document.createElement("style");
  t.id = "cb-select-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Select({
  options = [],
  value,
  onChange,
  size = "md",
  disabled,
  width,
  style,
  className = ""
}) {
  const h = size === "sm" ? "var(--control-h-sm)" : "var(--control-h)";
  return /*#__PURE__*/React.createElement("span", {
    className: `cb-select ${className}`,
    style: {
      width,
      ...style
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: value,
    onChange: onChange,
    disabled: disabled,
    style: {
      height: h
    }
  }, options.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label))), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    className: "cb-select-chev",
    name: "chevron-down",
    size: 14
  }));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Select.jsx", error: String((e && e.message) || e) }); }

// components/core/Switch.jsx
try { (() => {
const css = `
.cb-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm);user-select:none}
.cb-switch input{position:absolute;opacity:0;width:0;height:0}
.cb-switch .cb-track{width:32px;height:18px;border-radius:var(--r-full);background:var(--n-300);position:relative;transition:background var(--dur-fast) var(--ease-out);flex:none}
.cb-switch .cb-track::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:var(--shadow-xs);transition:transform var(--dur-fast) var(--ease-out)}
.cb-switch-on .cb-track{background:var(--accent)}
.cb-switch-on .cb-track::after{transform:translateX(14px)}
.cb-switch input:focus-visible+.cb-track{box-shadow:var(--ring)}
.cb-switch-disabled{opacity:.45;cursor:not-allowed}`;
if (typeof document !== "undefined" && !document.getElementById("cb-switch-css")) {
  const t = document.createElement("style");
  t.id = "cb-switch-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Switch({
  checked,
  onChange,
  label,
  disabled,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: `cb-switch ${checked ? "cb-switch-on" : ""} ${disabled ? "cb-switch-disabled" : ""} ${className}`,
    style: style
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    role: "switch",
    checked: !!checked,
    disabled: disabled,
    onChange: e => onChange && onChange(e.target.checked)
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-track"
  }), label ? /*#__PURE__*/React.createElement("span", null, label) : null);
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Switch.jsx", error: String((e && e.message) || e) }); }

// components/display/Avatar.jsx
try { (() => {
const PALETTE = ["#7BA8E0", "#7CC5A8", "#D9A46B", "#C08FD6", "#E08F9F", "#77BFCF", "#A3B06F", "#9099D9"];
const hash = s => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) | 0;
  return Math.abs(h);
};
const initials = n => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
function Avatar({
  name = "?",
  size = 24,
  src,
  style,
  className = ""
}) {
  const bg = PALETTE[hash(name) % PALETTE.length];
  const base = {
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    verticalAlign: "middle",
    ...style
  };
  if (src) return /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: name,
    title: name,
    className: className,
    style: {
      ...base,
      objectFit: "cover"
    }
  });
  return /*#__PURE__*/React.createElement("span", {
    title: name,
    className: className,
    style: {
      ...base,
      background: bg,
      color: "#fff",
      fontFamily: "var(--font-ui)",
      fontWeight: 600,
      fontSize: Math.round(size * 0.4),
      letterSpacing: "0.02em",
      userSelect: "none"
    }
  }, initials(name));
}
function AvatarGroup({
  names = [],
  size = 24,
  max = 3,
  style,
  className = ""
}) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return /*#__PURE__*/React.createElement("span", {
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      ...style
    }
  }, shown.map((n, i) => /*#__PURE__*/React.createElement(Avatar, {
    key: n + i,
    name: n,
    size: size,
    style: {
      marginLeft: i ? -size * 0.3 : 0,
      boxShadow: "0 0 0 2px var(--n-0)"
    }
  })), rest > 0 ? /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: -size * 0.3,
      width: size,
      height: size,
      borderRadius: "50%",
      background: "var(--n-100)",
      color: "var(--n-600)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: Math.round(size * 0.38),
      fontWeight: 600,
      boxShadow: "0 0 0 2px var(--n-0)"
    }
  }, "+", rest) : null);
}
Object.assign(__ds_scope, { Avatar, AvatarGroup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/display/Badge.jsx
try { (() => {
const css = `
.cb-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:var(--r-full);font-size:var(--text-2xs);font-weight:500;letter-spacing:0;white-space:nowrap}
.cb-badge-outline{background:transparent!important;border:1px solid currentColor}`;
if (typeof document !== "undefined" && !document.getElementById("cb-badge-css")) {
  const t = document.createElement("style");
  t.id = "cb-badge-css";
  t.textContent = css;
  document.head.appendChild(t);
}
const TONES = {
  neutral: {
    bg: "var(--n-100)",
    fg: "var(--n-700)"
  },
  info: {
    bg: "var(--cortex-50)",
    fg: "var(--cortex-700)"
  },
  success: {
    bg: "var(--success-50)",
    fg: "var(--success-700)"
  },
  warn: {
    bg: "var(--warn-50)",
    fg: "var(--warn-700)"
  },
  danger: {
    bg: "var(--danger-50)",
    fg: "var(--danger-700)"
  },
  ai: {
    bg: "var(--synapse-50)",
    fg: "var(--synapse-600)"
  }
};
function Badge({
  tone = "neutral",
  variant = "tint",
  children,
  style,
  className = ""
}) {
  const t = TONES[tone] || TONES.neutral;
  return /*#__PURE__*/React.createElement("span", {
    className: `cb-badge ${variant === "outline" ? "cb-badge-outline" : ""} ${className}`,
    style: {
      background: t.bg,
      color: t.fg,
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Badge.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
const css = `
.cb-card{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--r-lg);box-shadow:var(--shadow-sm)}
.cb-card-flat{box-shadow:none}
.cb-card-hover{transition:box-shadow var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);cursor:pointer}
.cb-card-hover:hover{box-shadow:var(--shadow-md);border-color:var(--n-300)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-card-css")) {
  const t = document.createElement("style");
  t.id = "cb-card-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Card({
  children,
  flat,
  hoverable,
  padding = 16,
  onClick,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    className: `cb-card ${flat ? "cb-card-flat" : ""} ${hoverable ? "cb-card-hover" : ""} ${className}`,
    style: {
      padding,
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/EntityIcon.jsx
try { (() => {
const MAP = {
  objective: {
    icon: "target",
    color: "var(--ent-objective)"
  },
  keyResult: {
    icon: "trending-up",
    color: "var(--ent-keyresult)"
  },
  initiative: {
    icon: "diamond",
    color: "var(--ent-initiative)"
  },
  product: {
    icon: "package",
    color: "var(--ent-product)"
  },
  component: {
    icon: "layout-grid",
    color: "var(--ent-component)"
  },
  release: {
    icon: "flag",
    color: "var(--ent-release)"
  },
  releaseGroup: {
    icon: "flag",
    color: "var(--ent-releasegroup)"
  },
  company: {
    icon: "building-2",
    color: "var(--ent-company)"
  },
  user: {
    icon: "circle-user",
    color: "var(--ent-user)"
  },
  signal: {
    icon: "message-square-text",
    color: "var(--n-600)"
  },
  finding: {
    icon: "radar",
    color: "var(--synapse-500)"
  },
  opportunity: {
    icon: "lightbulb",
    color: "var(--synapse-600)"
  },
  ai: {
    icon: "sparkles",
    color: "var(--synapse-500)"
  }
};
function EntityIcon({
  type,
  size = 16,
  swatch,
  style,
  className = ""
}) {
  if (type === "feature") {
    const s = Math.round(size * 0.7);
    return /*#__PURE__*/React.createElement("span", {
      className: className,
      title: "Feature",
      style: {
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        verticalAlign: "middle",
        ...style
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: s,
        height: s,
        borderRadius: Math.max(2, s * 0.28),
        background: swatch || "var(--ent-feature)"
      }
    }));
  }
  if (type === "subfeature") {
    const s = Math.round(size * 0.5);
    return /*#__PURE__*/React.createElement("span", {
      className: className,
      title: "Subfeature",
      style: {
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        verticalAlign: "middle",
        ...style
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: s,
        height: s,
        borderRadius: "50%",
        background: swatch || "var(--ent-subfeature)"
      }
    }));
  }
  const m = MAP[type] || {
    icon: "circle",
    color: "var(--n-500)"
  };
  return /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: m.icon,
    size: size,
    color: swatch || m.color,
    strokeWidth: 2,
    className: className,
    style: style
  });
}
Object.assign(__ds_scope, { EntityIcon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/EntityIcon.jsx", error: String((e && e.message) || e) }); }

// components/display/HealthChip.jsx
try { (() => {
const CFG = {
  on: {
    label: "On track",
    bg: "var(--success-50)",
    fg: "var(--success-700)",
    dot: "var(--health-on)"
  },
  risk: {
    label: "At risk",
    bg: "var(--warn-50)",
    fg: "var(--warn-700)",
    dot: "var(--health-risk)"
  },
  off: {
    label: "Off track",
    bg: "var(--danger-50)",
    fg: "var(--danger-700)",
    dot: "var(--health-off)"
  },
  none: {
    label: "No status",
    bg: "var(--n-50)",
    fg: "var(--n-500)",
    dot: "var(--health-none)"
  }
};
function HealthChip({
  health = "none",
  label,
  size = "md",
  style,
  className = ""
}) {
  const c = CFG[health] || CFG.none;
  const h = size === "sm" ? 20 : 24;
  return /*#__PURE__*/React.createElement("span", {
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: h,
      padding: "0 10px",
      borderRadius: "var(--r-full)",
      background: c.bg,
      color: c.fg,
      fontSize: "var(--text-xs)",
      fontWeight: 500,
      whiteSpace: "nowrap",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: c.dot,
      flex: "none"
    }
  }), label || c.label);
}
Object.assign(__ds_scope, { HealthChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/HealthChip.jsx", error: String((e && e.message) || e) }); }

// components/display/ProgressBar.jsx
try { (() => {
function ProgressBar({
  value = 0,
  width = 120,
  tone = "default",
  showLabel,
  style,
  className = ""
}) {
  const v = Math.max(0, Math.min(100, value));
  const fill = tone === "success" ? "var(--success-500)" : tone === "warn" ? "var(--warn-500)" : tone === "danger" ? "var(--danger-500)" : "var(--cortex-400)";
  return /*#__PURE__*/React.createElement("span", {
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width,
      height: 4,
      borderRadius: "var(--r-full)",
      background: "var(--n-100)",
      overflow: "hidden",
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      height: "100%",
      width: `${v}%`,
      borderRadius: "var(--r-full)",
      background: fill,
      transition: "width var(--dur-med) var(--ease-out)"
    }
  })), showLabel ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-2xs)",
      color: "var(--text-secondary)",
      minWidth: 30,
      textAlign: "right"
    }
  }, v, "%") : null);
}
Object.assign(__ds_scope, { ProgressBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/ProgressBar.jsx", error: String((e && e.message) || e) }); }

// components/display/StatusFlag.jsx
try { (() => {
const STATUSES = {
  idea: {
    label: "New idea",
    color: "var(--status-idea)"
  },
  planned: {
    label: "Planned",
    color: "var(--status-planned)"
  },
  progress: {
    label: "In progress",
    color: "var(--status-progress)"
  },
  validation: {
    label: "Validation",
    color: "var(--status-validation)"
  },
  released: {
    label: "Released",
    color: "var(--status-released)"
  },
  wontdo: {
    label: "Won't do",
    color: "var(--status-wontdo)"
  }
};
function StatusFlag({
  status = "idea",
  label,
  color,
  bare,
  size = "md",
  style,
  className = ""
}) {
  const s = STATUSES[status] || STATUSES.idea;
  const c = color || s.color;
  const flag = /*#__PURE__*/React.createElement("svg", {
    width: size === "sm" ? 12 : 14,
    height: size === "sm" ? 12 : 14,
    viewBox: "0 0 24 24",
    fill: c,
    stroke: "none",
    style: {
      flex: "none"
    },
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M6 3h13l-3.5 5L19 13H6v8H4V3h2z"
  }));
  if (bare) return /*#__PURE__*/React.createElement("span", {
    title: label || s.label,
    className: className,
    style: {
      display: "inline-flex",
      ...style
    }
  }, flag);
  return /*#__PURE__*/React.createElement("span", {
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: size === "sm" ? 20 : 24,
      padding: "0 8px",
      borderRadius: "var(--r-sm)",
      background: "var(--n-50)",
      border: "1px solid var(--n-200)",
      fontSize: "var(--text-xs)",
      fontWeight: 500,
      color: "var(--n-700)",
      whiteSpace: "nowrap",
      ...style
    }
  }, flag, label || s.label);
}
Object.assign(__ds_scope, { StatusFlag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/StatusFlag.jsx", error: String((e && e.message) || e) }); }

// components/display/Tag.jsx
try { (() => {
const css = `
.cb-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:var(--r-sm);border:1px solid var(--n-200);background:var(--n-50);font-size:var(--text-xs);font-weight:500;color:var(--n-700);white-space:nowrap;max-width:100%}
.cb-tag i.cb-tag-dot{width:8px;height:8px;border-radius:3px;flex:none}
.cb-tag .cb-tag-x{display:inline-flex;border:none;background:none;padding:0;margin-left:2px;color:var(--n-500);cursor:pointer;border-radius:2px}
.cb-tag .cb-tag-x:hover{color:var(--n-800)}
.cb-tag span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tag-css")) {
  const t = document.createElement("style");
  t.id = "cb-tag-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Tag({
  children,
  color,
  icon,
  onRemove,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `cb-tag ${className}`,
    style: style
  }, color ? /*#__PURE__*/React.createElement("i", {
    className: "cb-tag-dot",
    style: {
      background: color
    }
  }) : icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 12
  }) : null, /*#__PURE__*/React.createElement("span", null, children), onRemove ? /*#__PURE__*/React.createElement("button", {
    className: "cb-tag-x",
    onClick: onRemove,
    "aria-label": "Remove"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 12
  })) : null);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Tag.jsx", error: String((e && e.message) || e) }); }

// components/boards/KanbanCard.jsx
try { (() => {
const css = `
.cb-kcard{position:relative;background:var(--n-0);border:1px solid var(--n-200);border-radius:var(--r-lg);box-shadow:var(--shadow-xs);padding:10px 12px 10px 15px;cursor:pointer;transition:box-shadow var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);overflow:hidden}
.cb-kcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--kc,var(--ent-feature))}
.cb-kcard:hover{box-shadow:var(--shadow-md);border-color:var(--n-300)}
.cb-kcard-title{display:flex;align-items:flex-start;gap:7px;font-size:var(--text-sm);font-weight:500;color:var(--n-900);line-height:18px}
.cb-kcard-meta{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:var(--text-xs);color:var(--text-muted)}
.cb-kcard-tags{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}`;
if (typeof document !== "undefined" && !document.getElementById("cb-kcard-css")) {
  const t = document.createElement("style");
  t.id = "cb-kcard-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function KanbanCard({
  title,
  entity = "feature",
  swatch = "var(--ent-feature)",
  timeframe,
  owner,
  tags = [],
  onClick,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `cb-kcard ${className}`,
    onClick: onClick,
    style: {
      "--kc": swatch,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-kcard-title"
  }, /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: entity,
    swatch: swatch,
    size: 16,
    style: {
      marginTop: 1
    }
  }), title), tags.length ? /*#__PURE__*/React.createElement("div", {
    className: "cb-kcard-tags"
  }, tags.map((t, i) => /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    key: i,
    icon: t.icon,
    color: t.color
  }, t.label))) : null, /*#__PURE__*/React.createElement("div", {
    className: "cb-kcard-meta"
  }, timeframe ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "calendar",
    size: 12
  }), /*#__PURE__*/React.createElement("span", null, timeframe)) : null, owner ? /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: owner,
    size: 20,
    style: {
      marginLeft: "auto"
    }
  }) : null));
}
Object.assign(__ds_scope, { KanbanCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/boards/KanbanCard.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Dialog.jsx
try { (() => {
const css = `
.cb-dlg-scrim{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:flex-start;justify-content:center;padding:64px 24px;z-index:1000;animation:cbFade var(--dur-med) var(--ease-out)}
.cb-dlg{background:var(--n-0);border-radius:var(--r-xl);box-shadow:var(--shadow-lg);width:100%;display:flex;flex-direction:column;max-height:calc(100vh - 128px);animation:cbUp var(--dur-med) var(--ease-out)}
.cb-dlg-hd{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0 24px}
.cb-dlg-hd h2{margin:0;font-size:var(--text-lg);line-height:var(--leading-lg);font-weight:600;letter-spacing:var(--track-tight);color:var(--n-900)}
.cb-dlg-bd{padding:16px 24px;overflow:auto;font-size:var(--text-sm);color:var(--n-800)}
.cb-dlg-ft{display:flex;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--n-100)}
.cb-dlg-ft .cb-dlg-note{font-size:var(--text-xs);color:var(--text-muted);margin-right:auto}
@keyframes cbFade{from{opacity:0}to{opacity:1}}
@keyframes cbUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;
if (typeof document !== "undefined" && !document.getElementById("cb-dlg-css")) {
  const t = document.createElement("style");
  t.id = "cb-dlg-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Dialog({
  open,
  onClose,
  title,
  children,
  width = 560,
  primaryAction,
  secondaryAction,
  footerNote,
  style
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-dlg-scrim",
    onMouseDown: e => {
      if (e.target === e.currentTarget && onClose) onClose();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-dlg",
    role: "dialog",
    "aria-modal": "true",
    style: {
      maxWidth: width,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-dlg-hd"
  }, /*#__PURE__*/React.createElement("h2", null, title), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "x",
    label: "Close",
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-dlg-bd"
  }, children), primaryAction || secondaryAction || footerNote ? /*#__PURE__*/React.createElement("div", {
    className: "cb-dlg-ft"
  }, footerNote ? /*#__PURE__*/React.createElement("span", {
    className: "cb-dlg-note"
  }, footerNote) : /*#__PURE__*/React.createElement("span", {
    className: "cb-dlg-note"
  }), secondaryAction ? /*#__PURE__*/React.createElement(__ds_scope.Button, {
    onClick: secondaryAction.onClick
  }, secondaryAction.label) : null, primaryAction ? /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "primary",
    disabled: primaryAction.disabled,
    onClick: primaryAction.onClick
  }, primaryAction.label) : null) : null));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/feedback/EmptyState.jsx
try { (() => {
function EmptyState({
  icon = "inbox",
  title,
  description,
  action,
  compact,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: className,
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      padding: compact ? "24px 16px" : "56px 24px",
      gap: 4,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: compact ? 36 : 48,
      height: compact ? 36 : 48,
      borderRadius: "var(--r-lg)",
      background: "var(--n-50)",
      border: "1px solid var(--n-100)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: compact ? 16 : 20,
    color: "var(--n-400)",
    strokeWidth: 1.5
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: compact ? "var(--text-sm)" : "var(--text-lg)",
      fontWeight: 600,
      letterSpacing: "var(--track-tight)",
      color: "var(--n-800)"
    }
  }, title), description ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: compact ? "var(--text-xs)" : "var(--text-sm)",
      color: "var(--text-muted)",
      maxWidth: 340,
      lineHeight: 1.5
    }
  }, description) : null, action ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, action) : null);
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
const CFG = {
  neutral: {
    icon: "info",
    color: "var(--n-600)"
  },
  success: {
    icon: "circle-check",
    color: "var(--success-500)"
  },
  warn: {
    icon: "triangle-alert",
    color: "var(--warn-500)"
  },
  danger: {
    icon: "circle-alert",
    color: "var(--danger-500)"
  },
  ai: {
    icon: "sparkles",
    color: "var(--synapse-500)"
  }
};
function Toast({
  tone = "neutral",
  title,
  description,
  action,
  onDismiss,
  style,
  className = ""
}) {
  const c = CFG[tone] || CFG.neutral;
  return /*#__PURE__*/React.createElement("div", {
    className: className,
    role: "status",
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      width: 360,
      background: "var(--n-0)",
      border: "1px solid var(--n-200)",
      borderRadius: "var(--r-lg)",
      boxShadow: "var(--shadow-lg)",
      padding: "12px 12px 12px 14px",
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: c.icon,
    size: 16,
    color: c.color,
    style: {
      marginTop: 2
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      fontWeight: 600,
      color: "var(--n-900)"
    }
  }, title), description ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-xs)",
      color: "var(--text-secondary)",
      marginTop: 2
    }
  }, description) : null, action ? /*#__PURE__*/React.createElement("button", {
    onClick: action.onClick,
    style: {
      marginTop: 8,
      border: "none",
      background: "none",
      padding: 0,
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-xs)",
      fontWeight: 600,
      color: "var(--text-link)",
      cursor: "pointer"
    }
  }, action.label) : null), onDismiss ? /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "x",
    label: "Dismiss",
    size: "sm",
    onClick: onDismiss
  }) : null);
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
const css = `
.cb-tip{position:relative;display:inline-flex}
.cb-tip .cb-tip-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%) translateY(2px);background:var(--n-800);color:#fff;font-family:var(--font-ui);font-size:var(--text-2xs);line-height:16px;font-weight:500;padding:4px 8px;border-radius:var(--r-sm);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out);z-index:900}
.cb-tip:hover .cb-tip-bubble,.cb-tip:focus-within .cb-tip-bubble{opacity:1;transform:translateX(-50%) translateY(0)}
.cb-tip-bottom .cb-tip-bubble{bottom:auto;top:calc(100% + 6px)}
.cb-tip .cb-tip-kbd{font-family:var(--font-mono);opacity:.7;margin-left:6px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tip-css")) {
  const t = document.createElement("style");
  t.id = "cb-tip-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Tooltip({
  content,
  kbd,
  side = "top",
  children,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `cb-tip ${side === "bottom" ? "cb-tip-bottom" : ""} ${className}`,
    style: style
  }, children, /*#__PURE__*/React.createElement("span", {
    className: "cb-tip-bubble",
    role: "tooltip"
  }, content, kbd ? /*#__PURE__*/React.createElement("span", {
    className: "cb-tip-kbd"
  }, kbd) : null));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/navigation/FilterChip.jsx
try { (() => {
const css = `
.cb-fchip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--r-full);border:1px solid var(--n-300);background:var(--n-0);font-family:var(--font-ui);font-size:var(--text-xs);font-weight:500;color:var(--n-700);cursor:pointer;white-space:nowrap;transition:background var(--dur-fast) var(--ease-out);outline:none}
.cb-fchip:hover{background:var(--n-50)}
.cb-fchip:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-fchip-on{background:var(--surface-selected);border-color:var(--cortex-200);color:var(--cortex-700)}
.cb-fchip-on:hover{background:var(--cortex-100)}
.cb-fchip b{font-weight:600}
.cb-fchip .cb-fchip-x{display:inline-flex;border:none;background:none;padding:0;color:inherit;opacity:.6;cursor:pointer}
.cb-fchip .cb-fchip-x:hover{opacity:1}
.cb-fchip-dot{width:6px;height:6px;border-radius:50%;background:var(--success-500);flex:none;margin-left:2px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-fchip-css")) {
  const t = document.createElement("style");
  t.id = "cb-fchip-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function FilterChip({
  label,
  value,
  icon,
  active,
  dot,
  onClick,
  onRemove,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `cb-fchip ${active ? "cb-fchip-on" : ""} ${className}`,
    onClick: onClick,
    style: style
  }, icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 13
  }) : null, /*#__PURE__*/React.createElement("span", null, label, value ? /*#__PURE__*/React.createElement(React.Fragment, null, ": ", /*#__PURE__*/React.createElement("b", null, value)) : null), dot ? /*#__PURE__*/React.createElement("span", {
    className: "cb-fchip-dot"
  }) : null, onRemove ? /*#__PURE__*/React.createElement("span", {
    className: "cb-fchip-x",
    onClick: e => {
      e.stopPropagation();
      onRemove();
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 12
  })) : null);
}
Object.assign(__ds_scope, { FilterChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/FilterChip.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
const css = `
.cb-tabs{display:flex;gap:2px;border-bottom:1px solid var(--n-200)}
.cb-tab{font-family:var(--font-ui);font-size:var(--text-sm);font-weight:500;color:var(--n-600);background:none;border:none;border-bottom:2px solid transparent;height:34px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;outline:none;margin-bottom:-1px;transition:color var(--dur-fast) var(--ease-out)}
.cb-tab:hover{color:var(--n-900)}
.cb-tab:focus-visible{box-shadow:var(--ring);border-radius:var(--r-xs)}
.cb-tab-on{color:var(--n-900);border-bottom-color:var(--accent)}
.cb-tab .cb-tab-count{font-size:var(--text-2xs);font-weight:500;background:var(--n-100);color:var(--n-600);border-radius:var(--r-full);padding:0 6px;line-height:16px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tabs-css")) {
  const t = document.createElement("style");
  t.id = "cb-tabs-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Tabs({
  items = [],
  active,
  onChange,
  style,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `cb-tabs ${className}`,
    style: style,
    role: "tablist"
  }, items.map(it => /*#__PURE__*/React.createElement("button", {
    key: it.id,
    role: "tab",
    "aria-selected": it.id === active,
    className: `cb-tab ${it.id === active ? "cb-tab-on" : ""}`,
    onClick: () => onChange && onChange(it.id)
  }, it.icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: it.icon,
    size: 14
  }) : null, it.label, it.count != null ? /*#__PURE__*/React.createElement("span", {
    className: "cb-tab-count"
  }, it.count) : null)));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/AppShell.jsx
try { (() => {
const css = `
.cb-app{display:flex;height:100vh;min-height:560px;min-width:1180px;background:var(--surface-app);font-family:var(--font-ui);font-size:var(--text-sm);line-height:var(--leading-sm);color:var(--text-primary);overflow:hidden}
.cb-rail{width:var(--rail-w);flex:none;border-right:1px solid var(--n-100);display:flex;flex-direction:column;align-items:center;padding:12px 0;gap:4px;background:var(--n-0)}
.cb-rail-mark{width:32px;height:32px;border-radius:var(--r-md);background:var(--cortex-500);color:#fff;font-weight:700;font-size:17px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;letter-spacing:-0.02em;user-select:none}
.cb-rail-it{width:44px;padding:6px 0 5px;border:none;background:none;border-radius:var(--r-md);display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--n-500);font-family:var(--font-ui);font-size:10px;font-weight:500;cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-rail-it:hover{background:var(--n-50);color:var(--n-700)}
.cb-rail-it-on{color:var(--cortex-600)}
.cb-rail-it-on:hover{background:var(--cortex-50);color:var(--cortex-600)}
.cb-side{width:var(--sidebar-w);flex:none;background:var(--surface-sunken);border-right:1px solid var(--n-200);display:flex;flex-direction:column;overflow:hidden}
.cb-side-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 12px 8px 16px}
.cb-side-hd h1{margin:0;font-size:var(--text-md);font-weight:600;color:var(--n-900)}
.cb-side-scroll{flex:1;overflow-y:auto;padding:0 8px 16px}
.cb-side-sec{font-size:var(--text-2xs);font-weight:600;letter-spacing:var(--track-caps);text-transform:uppercase;color:var(--n-500);padding:14px 8px 4px}
.cb-nav-it{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:var(--r-sm);color:var(--n-700);cursor:pointer;user-select:none;border:none;background:none;width:100%;font-family:var(--font-ui);font-size:var(--text-sm);text-align:left;transition:background var(--dur-fast) var(--ease-out)}
.cb-nav-it:hover{background:var(--n-100)}
.cb-nav-it-on{background:var(--surface-selected);color:var(--cortex-700);font-weight:500}
.cb-nav-it-on:hover{background:var(--cortex-100)}
.cb-nav-it .cb-nav-count{margin-left:auto;font-size:var(--text-2xs);color:var(--n-500)}
.cb-top{height:var(--topbar-h);flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--n-200);background:var(--n-0)}
.cb-main{flex:1;display:flex;flex-direction:column;min-width:0}
.cb-canvas{flex:1;display:flex;min-height:0;background:var(--n-0)}
.cb-newbtn{width:30px;height:30px;border-radius:var(--r-md);background:var(--accent);color:#fff;border:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-newbtn:hover{background:var(--accent-hover)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-shell-css")) {
  const t = document.createElement("style");
  t.id = "cb-shell-css";
  t.textContent = css;
  document.head.appendChild(t);
}
const RAIL = [{
  id: "home",
  icon: "house",
  label: "Home"
}, {
  id: "agent",
  icon: "sparkles",
  label: "Agent"
}, {
  id: "library",
  icon: "library-big",
  label: "Library"
}];
const NAV = [{
  section: "Insights",
  items: [{
    id: "opportunities",
    icon: "lightbulb",
    label: "Opportunities",
    beta: true,
    rail: "agent"
  }, {
    id: "knowledge",
    icon: "message-square-text",
    label: "Knowledge",
    count: 5,
    rail: "library"
  }]
}, {
  section: "Product",
  items: [{
    id: "objectives",
    icon: "target",
    label: "Objectives",
    rail: "home"
  }, {
    id: "initiatives",
    icon: "diamond",
    label: "Initiatives",
    rail: "home"
  }, {
    id: "features",
    icon: "square-stack",
    label: "Features",
    rail: "home"
  }]
}, {
  section: "Boards",
  items: [{
    id: "okr",
    icon: "table-2",
    label: "Strategic OKR planning",
    rail: "home"
  }, {
    id: "roadmap",
    icon: "calendar-range",
    label: "Initiatives roadmap",
    rail: "home"
  }, {
    id: "delivery",
    icon: "kanban",
    label: "Delivery board",
    rail: "home"
  }]
}, {
  section: "Agent",
  items: [{
    id: "agenthome",
    icon: "sparkles",
    label: "Cerebro overview",
    rail: "agent"
  }]
}];
function AppShell({
  active,
  onNavigate,
  children,
  onAsk
}) {
  const activeRail = (NAV.flatMap(s => s.items).find(i => i.id === active) || {}).rail || "home";
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-app"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-rail"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-rail-mark",
    title: "Cerebro"
  }, "c."), RAIL.map(r => /*#__PURE__*/React.createElement("button", {
    key: r.id,
    className: `cb-rail-it ${r.id === activeRail ? "cb-rail-it-on" : ""}`,
    onClick: () => onNavigate && onNavigate(r.id === "agent" ? "agenthome" : r.id === "library" ? "knowledge" : "okr")
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: r.icon,
    size: 18,
    strokeWidth: r.id === activeRail ? 2 : 1.75
  }), r.label)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "cb-rail-it"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "settings",
    size: 18
  }), "Settings")), /*#__PURE__*/React.createElement("div", {
    className: "cb-side"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-side-hd"
  }, /*#__PURE__*/React.createElement("h1", null, "Workspace"), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "panel-left",
    label: "Collapse",
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-side-scroll"
  }, NAV.map(sec => /*#__PURE__*/React.createElement("div", {
    key: sec.section
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-side-sec"
  }, sec.section), sec.items.map(it => /*#__PURE__*/React.createElement("button", {
    key: it.id,
    className: `cb-nav-it ${active === it.id ? "cb-nav-it-on" : ""}`,
    onClick: () => onNavigate && onNavigate(it.id)
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: it.icon,
    size: 15,
    color: active === it.id ? "var(--cortex-600)" : "var(--n-500)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, it.label), it.beta ? /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    style: {
      marginLeft: "auto"
    }
  }, "Beta") : it.count != null ? /*#__PURE__*/React.createElement("span", {
    className: "cb-nav-count"
  }, it.count) : null)))))), /*#__PURE__*/React.createElement("div", {
    className: "cb-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-top"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 16,
      letterSpacing: "-0.02em"
    }
  }, "cerebro", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--synapse-500)"
    }
  }, ".")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: "flex",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.AskBar, {
    width: 480,
    onSubmit: onAsk
  })), /*#__PURE__*/React.createElement("button", {
    className: "cb-newbtn",
    title: "Create"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "plus",
    size: 16
  })), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "bell",
    label: "Notifications"
  }), /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: "Maya Chen",
    size: 28
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-canvas"
  }, children)));
}
Object.assign(__ds_scope, { NAV, AppShell });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/AppShell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/BoardChrome.jsx
try { (() => {
const css = `
.cb-view{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.cb-viewhd{padding:14px 20px 0;flex:none}
.cb-viewhd-t{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.cb-viewhd-t h1{margin:0;font-size:var(--text-xl);line-height:var(--leading-xl);font-weight:600;letter-spacing:var(--track-tight)}
.cb-viewhd-t .cb-crumb{color:var(--n-500);font-size:var(--text-sm);display:flex;align-items:center;gap:6px}
.cb-toolbar{display:flex;align-items:center;gap:8px;padding-bottom:12px}
.cb-body{flex:1;overflow:auto;min-height:0}
.cb-grid-head{display:flex;align-items:center;height:var(--row-head-h);border-top:1px solid var(--n-200);border-bottom:1px solid var(--n-200);background:var(--n-25);font-size:var(--text-xs);font-weight:500;color:var(--n-600);position:sticky;top:0;z-index:2}
.cb-grid-head>div{display:flex;align-items:center;gap:6px;padding:0 12px;border-right:1px solid var(--n-100);height:100%}
.cb-grid-head>div:last-child{border-right:none}
.cb-row{display:flex;align-items:center;height:var(--row-h);border-bottom:1px solid var(--n-100);cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-row:hover{background:var(--n-50)}
.cb-row-on{background:var(--surface-selected)}
.cb-row-on:hover{background:var(--surface-selected)}
.cb-row>div{padding:0 12px;display:flex;align-items:center;gap:8px;min-width:0}
.cb-row>div.cb-cell-name{flex:1;min-width:240px;font-weight:500;color:var(--n-900)}
.cb-cell-name .cb-name-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-grp{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:var(--n-25);border-bottom:1px solid var(--n-100);font-weight:600;font-size:var(--text-sm);color:var(--n-800);position:sticky;top:var(--row-head-h);z-index:1}
.cb-chev{color:var(--n-400);transition:transform var(--dur-fast) var(--ease-out);flex:none}
.cb-chev-open{transform:rotate(90deg)}
.cb-addrow{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;color:var(--n-500);cursor:pointer;font-size:var(--text-sm)}
.cb-addrow:hover{color:var(--n-700);background:var(--n-25)}
.cb-mono{font-family:var(--font-mono);font-size:11px;color:var(--n-600)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-board-css")) {
  const t = document.createElement("style");
  t.id = "cb-board-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function BoardHeader({
  icon,
  entity,
  crumb,
  title,
  onControls,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-viewhd"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-viewhd-t"
  }, crumb ? /*#__PURE__*/React.createElement("span", {
    className: "cb-crumb"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "layers",
    size: 14
  }), crumb, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-right",
    size: 13
  })) : null, entity ? /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: entity,
    size: 17
  }) : icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 17,
    color: "var(--n-600)"
  }) : null, /*#__PURE__*/React.createElement("h1", null, title), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "star",
    label: "Favorite",
    size: "sm"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "search",
    label: "Search this board"
  }), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "ghost",
    icon: "settings-2",
    onClick: onControls
  }, "Board controls"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "primary",
    size: "sm"
  }, "Save")), /*#__PURE__*/React.createElement("div", {
    className: "cb-toolbar"
  }, children));
}
function DefaultChips() {
  const [scope, setScope] = React.useState("my");
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    label: "My items",
    active: scope === "my",
    onClick: () => setScope("my")
  }), /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    label: "Team items",
    active: scope === "team",
    onClick: () => setScope("team")
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 1,
      height: 18,
      background: "var(--n-200)",
      margin: "0 4px"
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    icon: "list-filter",
    label: "Filtered by",
    value: "Owner",
    dot: true,
    onRemove: () => {}
  }), /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    icon: "plus",
    label: "Add filter"
  }));
}
Object.assign(__ds_scope, { BoardHeader, DefaultChips });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/BoardChrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/BoardControls.jsx
try { (() => {
const css = `
.cb-ctrl{width:var(--controls-w);flex:none;border-left:1px solid var(--n-200);background:var(--n-0);display:flex;flex-direction:column;min-height:0;animation:cbPanelIn var(--dur-med) var(--ease-out)}
.cb-ctrl-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px}
.cb-ctrl-hd h2{margin:0;font-size:var(--text-lg);font-weight:600;letter-spacing:var(--track-tight)}
.cb-ctrl-bd{flex:1;overflow-y:auto;padding:0 16px 16px;display:flex;flex-direction:column;gap:18px}
.cb-ctrl-sec{display:flex;flex-direction:column;gap:10px}
.cb-ctrl-sec .cb-ctrl-t{display:flex;align-items:center;justify-content:space-between;font-size:var(--text-md);font-weight:600}
.cb-ctrl-t a{font-size:var(--text-xs);font-weight:500}
.cb-where{border:1px solid var(--n-200);border-radius:var(--r-md);padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--n-25)}
.cb-where .cb-where-r{display:flex;align-items:center;gap:8px;font-size:var(--text-xs);color:var(--n-600)}
.cb-ctrl-ft{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--n-100)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ctrl-css")) {
  const t = document.createElement("style");
  t.id = "cb-ctrl-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function BoardControls({
  layout,
  onLayout,
  onClose
}) {
  const [hideLinked, setHideLinked] = React.useState(false);
  const [archived, setArchived] = React.useState(false);
  const [hideEmpty, setHideEmpty] = React.useState(true);
  return /*#__PURE__*/React.createElement("aside", {
    className: "cb-ctrl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-hd"
  }, /*#__PURE__*/React.createElement("h2", null, "Board controls"), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "x",
    label: "Close",
    size: "sm",
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-bd"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-sec"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-t"
  }, "Layout"), /*#__PURE__*/React.createElement(__ds_scope.SegmentedControl, {
    size: "md",
    value: layout,
    onChange: onLayout,
    options: [{
      value: "grid",
      label: "Grid",
      icon: "table-2"
    }, {
      value: "timeline",
      label: "Timeline",
      icon: "calendar-range"
    }, {
      value: "columns",
      label: "Columns",
      icon: "kanban"
    }]
  }), /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: hideLinked,
    onChange: setHideLinked,
    label: "Hide indirectly linked items"
  }), /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: archived,
    onChange: setArchived,
    label: "Include archived items"
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-sec"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-t"
  }, "Filters", /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => e.preventDefault()
  }, "Clear all")), /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: hideEmpty,
    onChange: setHideEmpty,
    label: "Hide empty items"
  }), /*#__PURE__*/React.createElement("div", {
    className: "cb-where"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-where-r"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "diamond",
    size: 13
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 500,
      color: "var(--n-800)"
    }
  }, "Initiatives, Features"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 11
    }
  }, "where")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Select, {
    size: "sm",
    width: "50%",
    options: [{
      value: "owner",
      label: "Owner"
    }, {
      value: "team",
      label: "Team"
    }]
  }), /*#__PURE__*/React.createElement(__ds_scope.Select, {
    size: "sm",
    width: "50%",
    options: [{
      value: "any",
      label: "is any of"
    }, {
      value: "none",
      label: "is none of"
    }]
  })), /*#__PURE__*/React.createElement(__ds_scope.Select, {
    size: "sm",
    width: "100%",
    options: [{
      value: "me",
      label: "Me (Maya Chen)"
    }, {
      value: "team",
      label: "Field Platform"
    }]
  })), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "ghost",
    icon: "plus",
    size: "sm",
    style: {
      alignSelf: "flex-start"
    }
  }, "Add filter")), /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-sec"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-t"
  }, "Groups", /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => e.preventDefault()
  }, "Clear all")), /*#__PURE__*/React.createElement(__ds_scope.Select, {
    width: "100%",
    options: [{
      value: "status",
      label: "Initiative status"
    }, {
      value: "objective",
      label: "Objective"
    }, {
      value: "owner",
      label: "Owner"
    }]
  }), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "ghost",
    icon: "plus",
    size: "sm",
    style: {
      alignSelf: "flex-start"
    }
  }, "Add grouping"))), /*#__PURE__*/React.createElement("div", {
    className: "cb-ctrl-ft"
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "ghost",
    icon: "rotate-ccw",
    size: "sm"
  }, "Reset changes"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "primary",
    size: "sm"
  }, "Apply")));
}
Object.assign(__ds_scope, { BoardControls });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/BoardControls.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/DetailPanel.jsx
try { (() => {
const css = `
.cb-panel{width:var(--panel-w);flex:none;border-left:1px solid var(--n-200);background:var(--n-0);display:flex;flex-direction:column;min-height:0;animation:cbPanelIn var(--dur-med) var(--ease-out)}
@keyframes cbPanelIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
.cb-panel-hd{padding:12px 16px 0}
.cb-panel-top{display:flex;align-items:center;gap:4px}
.cb-panel-name{font-size:var(--text-xl);line-height:var(--leading-xl);font-weight:600;letter-spacing:var(--track-tight);margin:10px 0 12px;display:flex;gap:10px;align-items:flex-start}
.cb-panel-bd{flex:1;overflow-y:auto;padding:16px}
.cb-field{display:flex;align-items:center;gap:8px;min-height:32px;font-size:var(--text-sm)}
.cb-field .cb-field-k{display:flex;align-items:center;gap:8px;width:130px;flex:none;color:var(--n-500)}
.cb-sec{font-size:var(--text-2xs);font-weight:600;letter-spacing:var(--track-caps);text-transform:uppercase;color:var(--n-500);margin:18px 0 8px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-panel-css")) {
  const t = document.createElement("style");
  t.id = "cb-panel-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function Field({
  icon,
  k,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "cb-field-k"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 14
  }), k), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      minWidth: 0
    }
  }, children));
}
function DetailPanel({
  item,
  onClose
}) {
  const [tab, setTab] = React.useState("details");
  React.useEffect(() => {
    setTab("details");
  }, [item && item.id]);
  if (!item) return null;
  const isObjective = item.kind === "objective";
  return /*#__PURE__*/React.createElement("aside", {
    className: "cb-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-panel-hd"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-panel-top"
  }, item.status ? /*#__PURE__*/React.createElement(__ds_scope.StatusFlag, {
    status: item.status,
    size: "sm"
  }) : /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: item.health,
    size: "sm"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "maximize-2",
    label: "Open full page",
    size: "sm"
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "ellipsis",
    label: "More",
    size: "sm"
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "x",
    label: "Close",
    size: "sm",
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-panel-name"
  }, /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: item.kind,
    swatch: item.swatch,
    size: 20,
    style: {
      marginTop: 4
    }
  }), item.name), /*#__PURE__*/React.createElement(__ds_scope.Tabs, {
    active: tab,
    onChange: setTab,
    items: [{
      id: "details",
      label: "Details"
    }, {
      id: "spec",
      label: "Spec"
    }, {
      id: "insights",
      label: "Insights",
      count: item.insights || 0
    }, {
      id: "health",
      label: "Health"
    }]
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-panel-bd"
  }, tab === "details" ? /*#__PURE__*/React.createElement("div", null, item.summary ? /*#__PURE__*/React.createElement(__ds_scope.AISummary, {
    sources: item.sources || "From linked signals",
    onRegenerate: () => {},
    style: {
      marginBottom: 16
    }
  }, item.summary) : null, item.description ? /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 16px",
      color: "var(--n-700)",
      lineHeight: "20px"
    }
  }, item.description) : null, /*#__PURE__*/React.createElement("div", {
    className: "cb-sec"
  }, "Fields"), item.status ? /*#__PURE__*/React.createElement(Field, {
    icon: "bookmark",
    k: "Status"
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusFlag, {
    status: item.status,
    size: "sm"
  })) : null, item.health ? /*#__PURE__*/React.createElement(Field, {
    icon: "activity",
    k: "Health"
  }, /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: item.health,
    size: "sm"
  })) : null, /*#__PURE__*/React.createElement(Field, {
    icon: "briefcase",
    k: "Owner"
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: item.owner,
    size: 20
  }), /*#__PURE__*/React.createElement("span", null, item.owner)), item.team ? /*#__PURE__*/React.createElement(Field, {
    icon: "users",
    k: "Team"
  }, item.team) : null, /*#__PURE__*/React.createElement(Field, {
    icon: "calendar",
    k: "Timeframe"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12
    }
  }, item.timeframe)), item.progress != null ? /*#__PURE__*/React.createElement(Field, {
    icon: "percent",
    k: "Work progress"
  }, /*#__PURE__*/React.createElement(__ds_scope.ProgressBar, {
    value: item.progress,
    showLabel: true
  })) : null, item.objective ? /*#__PURE__*/React.createElement(Field, {
    icon: "target",
    k: "Objectives"
  }, /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    icon: "target"
  }, item.objective)) : null, item.release ? /*#__PURE__*/React.createElement(Field, {
    icon: "flag",
    k: "Releases"
  }, /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    icon: "flag"
  }, item.release)) : null, item.krs ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "cb-sec"
  }, "Key results"), item.krs.map(kr => /*#__PURE__*/React.createElement("div", {
    key: kr.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 0",
      borderBottom: "1px solid var(--n-100)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: "keyResult",
    size: 15
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, kr.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--n-500)"
    }
  }, kr.current), /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: kr.health,
    size: "sm"
  })))) : null) : tab === "spec" ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--n-700)",
      lineHeight: "20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px dashed var(--n-300)",
      borderRadius: "var(--r-lg)",
      padding: "14px 16px",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontWeight: 600
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "sparkles",
    size: 14,
    color: "var(--synapse-500)"
  }), "Draft a spec"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-xs)",
      color: "var(--text-muted)",
      marginTop: 4
    }
  }, "Cerebro writes a delivery-ready spec from the linked signals and strategy context.")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      color: "var(--text-muted)",
      fontSize: "var(--text-xs)"
    }
  }, "Start writing, or type \"/\" for commands and \"@\" for mentions.")) : tab === "insights" ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--text-muted)",
      fontSize: "var(--text-xs)"
    }
  }, item.insights || 0, " linked signals inform this item. Newest first.") : /*#__PURE__*/React.createElement("div", null, isObjective ? /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: item.health
  }) : /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: "none"
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-muted)",
      fontSize: "var(--text-xs)"
    }
  }, "Health is reported weekly by the owner."))));
}
Object.assign(__ds_scope, { DetailPanel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/DetailPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/data.js
try { (() => {
const PEOPLE = ["Maya Chen", "Josef Lang", "Ana Rios", "Sam Ito", "Priya Nair", "Mo Byrd"];
const OBJECTIVES = [{
  id: "obj-1",
  name: "Increase Field App adoption",
  timeframe: "2026",
  owner: "Maya Chen",
  health: "on",
  progress: 40,
  team: "Field Platform",
  description: "Field technicians default to email and phone because the app's first-run experience stalls them. This objective tracks making Field App the daily tool of record.",
  krs: [{
    id: "kr-11",
    name: "5,000 weekly active technicians",
    timeframe: "Q3, 2026 – Q4, 2026",
    owner: "Ana Rios",
    health: "on",
    progress: 62,
    current: "3,100 / 5,000"
  }, {
    id: "kr-12",
    name: "First setup under 10 minutes",
    timeframe: "Q3, 2026 – Q4, 2026",
    owner: "Sam Ito",
    health: "risk",
    progress: 35,
    current: "18 min median"
  }]
}, {
  id: "obj-2",
  name: "Consolidate tooling onto Console",
  timeframe: "2026",
  owner: "Josef Lang",
  health: "risk",
  progress: 25,
  team: "Internal Systems",
  description: "Twelve legacy tools still hold workflows hostage. Consolidation cuts license spend and puts every service request behind one queue.",
  krs: [{
    id: "kr-21",
    name: "Migrate 12 legacy tools",
    timeframe: "2026",
    owner: "Josef Lang",
    health: "risk",
    progress: 42,
    current: "5 / 12 migrated"
  }, {
    id: "kr-22",
    name: "95% of service requests via Console",
    timeframe: "Q4, 2026",
    owner: "Mo Byrd",
    health: "on",
    progress: 55,
    current: "71% today"
  }]
}, {
  id: "obj-3",
  name: "Raise knowledge reuse across teams",
  timeframe: "H2 2026",
  owner: "Priya Nair",
  health: "on",
  progress: 55,
  team: "Knowledge",
  description: "Answers exist but don't travel. Cerebro should make the second ask of any question instant.",
  krs: [{
    id: "kr-31",
    name: "80% of specs cite at least one signal",
    timeframe: "Q3, 2026 – Q4, 2026",
    owner: "Priya Nair",
    health: "on",
    progress: 71,
    current: "64% today"
  }, {
    id: "kr-32",
    name: "Median answer time under 2 minutes",
    timeframe: "Q4, 2026",
    owner: "Mo Byrd",
    health: "none",
    progress: 0,
    current: "Not started"
  }]
}];
const INITIATIVES = [{
  id: "init-1",
  name: "Guided mobile onboarding",
  status: "progress",
  owner: "Ana Rios",
  objective: "Increase Field App adoption",
  progress: 40,
  timeframe: "Jun 2026 → Oct 2026",
  swatch: "var(--swatch-teal)",
  start: 5,
  len: 4,
  features: [{
    id: "ft-11",
    name: "Setup checklist",
    swatch: "var(--swatch-teal)",
    status: "released",
    start: 5,
    len: 2,
    release: "Field App 4.2",
    owner: "Ana Rios"
  }, {
    id: "ft-12",
    name: "Offline-first sync",
    swatch: "var(--swatch-blue)",
    status: "progress",
    start: 6,
    len: 3,
    release: "Field App 4.3",
    owner: "Sam Ito"
  }]
}, {
  id: "init-2",
  name: "Single sign-on everywhere",
  status: "progress",
  owner: "Sam Ito",
  objective: "Consolidate tooling onto Console",
  progress: 65,
  timeframe: "May 2026 → Aug 2026",
  swatch: "var(--swatch-amber)",
  start: 4,
  len: 4,
  features: [{
    id: "ft-21",
    name: "SAML for Console",
    swatch: "var(--swatch-amber)",
    status: "validation",
    start: 6,
    len: 2,
    release: "Console 2026.09",
    owner: "Sam Ito"
  }, {
    id: "ft-22",
    name: "Device trust checks",
    swatch: "var(--swatch-blue)",
    status: "planned",
    start: 7,
    len: 3,
    release: "Console 2026.10",
    owner: "Mo Byrd"
  }]
}, {
  id: "init-3",
  name: "Console migration · wave 2",
  status: "planned",
  owner: "Josef Lang",
  objective: "Consolidate tooling onto Console",
  progress: 10,
  timeframe: "Aug 2026 → Nov 2026",
  swatch: "var(--swatch-vermilion)",
  start: 7,
  len: 4,
  features: [{
    id: "ft-31",
    name: "Ticket importer",
    swatch: "var(--swatch-vermilion)",
    status: "planned",
    start: 7,
    len: 2,
    release: "Console 2026.10",
    owner: "Josef Lang"
  }]
}, {
  id: "init-4",
  name: "Signal capture in the field",
  status: "idea",
  owner: "Priya Nair",
  objective: "Raise knowledge reuse across teams",
  progress: 0,
  timeframe: "Sep 2026 → Dec 2026",
  swatch: "var(--swatch-magenta)",
  start: 8,
  len: 4,
  features: [{
    id: "ft-41",
    name: "Voice notes → signals",
    swatch: "var(--swatch-violet)",
    status: "idea",
    start: 8,
    len: 3,
    release: "",
    owner: "Priya Nair"
  }]
}];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DELIVERY = [{
  status: "idea",
  cards: [{
    title: "Voice notes → signals",
    swatch: "var(--swatch-violet)",
    timeframe: "Sep 2026 → Dec 2026",
    owner: "Priya Nair"
  }, {
    title: "Shift-handoff summaries",
    swatch: "var(--swatch-magenta)",
    timeframe: "Q4 2026",
    owner: "Mo Byrd"
  }]
}, {
  status: "planned",
  cards: [{
    title: "Device trust checks",
    swatch: "var(--swatch-blue)",
    timeframe: "Aug 2026 → Oct 2026",
    owner: "Mo Byrd",
    tags: [{
      label: "Single sign-on everywhere",
      icon: "diamond"
    }]
  }, {
    title: "Ticket importer",
    swatch: "var(--swatch-vermilion)",
    timeframe: "Aug 2026 → Sep 2026",
    owner: "Josef Lang",
    tags: [{
      label: "Console 2026.10",
      icon: "flag"
    }]
  }]
}, {
  status: "progress",
  cards: [{
    title: "Offline-first sync",
    swatch: "var(--swatch-blue)",
    timeframe: "Jul 2026 → Sep 2026",
    owner: "Sam Ito",
    tags: [{
      label: "Guided mobile onboarding",
      icon: "diamond"
    }]
  }, {
    title: "SAML for Console",
    swatch: "var(--swatch-amber)",
    timeframe: "Jul 2026 → Aug 2026",
    owner: "Sam Ito"
  }]
}, {
  status: "validation",
  cards: [{
    title: "Setup checklist",
    swatch: "var(--swatch-teal)",
    timeframe: "Jun 2026 → Jul 2026",
    owner: "Ana Rios",
    tags: [{
      label: "Field App 4.2",
      icon: "flag"
    }]
  }]
}, {
  status: "released",
  cards: [{
    title: "Unified login page",
    swatch: "var(--swatch-amber)",
    timeframe: "May 2026",
    owner: "Sam Ito",
    tags: [{
      label: "Console 2026.08",
      icon: "flag"
    }]
  }]
}];
const SIGNALS = [{
  id: "sg-1",
  team: "Field Ops",
  author: "Marcus Webb",
  kind: "Call note",
  time: "8:45 PM",
  unread: true,
  text: "We love the web app but our field teams are mostly on mobile and the experience there is… not there yet. Most techs give up during setup and fall back to email.",
  summary: "Field teams stall during mobile setup and revert to email; a guided, step-by-step first run would unblock adoption.",
  sources: "From 1 call · Field Ops",
  linked: {
    type: "feature",
    label: "Setup checklist",
    swatch: "var(--swatch-teal)"
  }
}, {
  id: "sg-2",
  team: "Support",
  author: "Lena Ortiz",
  kind: "Slack thread",
  time: "6:12 PM",
  unread: true,
  text: "Third time this week someone rewrote the same troubleshooting answer. We have it in two wikis and a doc — nobody finds any of them.",
  summary: "Duplicate answers persist across three knowledge stores; discovery, not authoring, is the bottleneck.",
  sources: "From 4 messages · Support",
  linked: {
    type: "opportunity",
    label: "One search across tools"
  }
}, {
  id: "sg-3",
  team: "Sales EU",
  author: "Tom Keller",
  kind: "Service ticket",
  time: "Mon 9:02 AM",
  text: "Requesting the weekly pipeline export again. Every Monday I pull the same filtered view and mail it to the region leads.",
  summary: "Weekly manual exports of the same filtered view; scheduled delivery to email would remove the chore.",
  sources: "From 3 tickets · Sales EU",
  linked: {
    type: "feature",
    label: "Scheduled exports",
    swatch: "var(--swatch-amber)"
  }
}, {
  id: "sg-4",
  team: "Field Ops",
  author: "Rosa Alvine",
  kind: "Survey response",
  time: "Fri 4:40 PM",
  text: "Offline mode. That's it. Basements and rural sites have no coverage and the app is a brick there.",
  summary: "No-coverage sites make the app unusable; offline-first sync is the single most requested capability.",
  sources: "From 9 responses · Field Ops",
  linked: {
    type: "feature",
    label: "Offline-first sync",
    swatch: "var(--swatch-blue)"
  }
}, {
  id: "sg-5",
  team: "Internal Systems",
  author: "Dana Fox",
  kind: "Email",
  time: "Thu 11:20 AM",
  text: "Legacy asset tracker exports break every time IT rotates certificates. Can Console own this workflow already?",
  summary: "Legacy tracker integration is brittle; migrating the workflow into Console would end recurring breakage.",
  sources: "From 2 emails · Internal Systems",
  linked: {
    type: "initiative",
    label: "Console migration · wave 2"
  }
}];
const OPPORTUNITIES = [{
  id: "op-1",
  title: "Guided setup for field teams",
  strength: "High signal",
  findings: 12,
  okr: "Increase Field App adoption",
  statement: "Technicians abandon setup on mobile and revert to email. A guided first-run with progress steps unblocks the largest adoption gap.",
  sources: "12 findings · 3 teams · roadmap gap: onboarding"
}, {
  id: "op-2",
  title: "Scheduled report exports",
  strength: "Medium signal",
  findings: 6,
  okr: "Consolidate tooling onto Console",
  statement: "Ops and sales re-export identical filtered views weekly. Scheduled, filtered exports to email or Slack remove a recurring chore.",
  sources: "6 findings · 2 teams · competitive: parity gap"
}, {
  id: "op-3",
  title: "One search across tools",
  strength: "Medium signal",
  findings: 5,
  okr: "Raise knowledge reuse across teams",
  statement: "Answers exist in three stores but aren't found. A single ask-surface over all knowledge cuts duplicate authoring.",
  sources: "5 findings · 4 teams · strategy: knowledge reuse"
}];
const SKILLS = [{
  name: "Summarize entity",
  desc: "Tiered rollups for any product, objective, or feature.",
  enabled: true
}, {
  name: "Draft spec from signals",
  desc: "Delivery-ready spec grounded in linked signals.",
  enabled: true
}, {
  name: "Weekly opportunity briefing",
  desc: "Top three evidence-backed problems, every Monday.",
  enabled: true
}, {
  name: "Competitive scan",
  desc: "Watches selected vendors for relevant changes.",
  enabled: false
}];
const AUTOMATIONS = [{
  name: "Monday adoption digest",
  freq: "Weekly · Mon 9:00 AM",
  skill: "Summarize entity",
  output: "Field Platform space",
  active: true
}, {
  name: "Signal triage",
  freq: "Hourly",
  skill: "Draft spec from signals",
  output: "Inbox",
  active: true
}];
Object.assign(__ds_scope, { PEOPLE, OBJECTIVES, INITIATIVES, MONTHS, DELIVERY, SIGNALS, OPPORTUNITIES, SKILLS, AUTOMATIONS });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/data.js", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/AgentHome.jsx
try { (() => {
const css = `
.cb-ag{flex:1;overflow-y:auto;padding:24px 32px;background:var(--surface-board)}
.cb-ag-hd{max-width:960px;margin:0 auto 20px}
.cb-ag-hd h1{margin:0 0 2px;font-size:var(--text-2xl);line-height:var(--leading-2xl);font-weight:600;letter-spacing:var(--track-display)}
.cb-ag-hd p{margin:0;color:var(--text-muted)}
.cb-ag-sec{max-width:960px;margin:0 auto 24px}
.cb-ag-sec>.t{display:flex;align-items:center;gap:8px;font-size:var(--text-md);font-weight:600;margin-bottom:10px}
.cb-ops{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.cb-op-t{display:flex;align-items:flex-start;gap:8px;font-size:var(--text-md);font-weight:600;line-height:20px;margin:8px 0 6px}
.cb-op-s{font-size:var(--text-xs);color:var(--n-600);line-height:18px;flex:1}
.cb-op-src{font-size:var(--text-2xs);color:var(--synapse-600);margin-top:10px}
.cb-op-ft{display:flex;gap:8px;margin-top:12px}
.cb-li{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--n-100)}
.cb-li:last-child{border-bottom:none}
.cb-li .nm{font-weight:500}
.cb-li .ds{font-size:var(--text-xs);color:var(--text-muted)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ag-css")) {
  const t = document.createElement("style");
  t.id = "cb-ag-css";
  t.textContent = css;
  document.head.appendChild(t);
}
const FieldL = ({
  label,
  req,
  children
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 14
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    marginBottom: 6
  }
}, label, req ? /*#__PURE__*/React.createElement("span", {
  style: {
    color: "var(--danger-500)"
  }
}, " *") : null), children);
function AgentHome() {
  const [skills, setSkills] = React.useState(__ds_scope.SKILLS);
  const [dlg, setDlg] = React.useState(false);
  const [freq, setFreq] = React.useState("daily");
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-view"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ag"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-ag-hd"
  }, /*#__PURE__*/React.createElement("h1", null, "Good morning, Maya"), /*#__PURE__*/React.createElement("p", null, "Three opportunities surfaced from last week's signals. Every claim links back to its source.")), /*#__PURE__*/React.createElement("div", {
    className: "cb-ag-sec"
  }, /*#__PURE__*/React.createElement("div", {
    className: "t"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "lightbulb",
    size: 16,
    color: "var(--synapse-600)"
  }), "This week's opportunities", /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: "ai"
  }, "Generated")), /*#__PURE__*/React.createElement("div", {
    className: "cb-ops"
  }, __ds_scope.OPPORTUNITIES.map(op => /*#__PURE__*/React.createElement(__ds_scope.Card, {
    key: op.id,
    hoverable: true,
    padding: 16,
    style: {
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: "ai"
  }, op.strength), /*#__PURE__*/React.createElement(__ds_scope.Badge, null, op.findings, " findings")), /*#__PURE__*/React.createElement("div", {
    className: "cb-op-t"
  }, op.title), /*#__PURE__*/React.createElement("div", {
    className: "cb-op-s"
  }, op.statement), /*#__PURE__*/React.createElement("div", {
    className: "cb-op-src"
  }, op.sources), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    icon: "target"
  }, op.okr)), /*#__PURE__*/React.createElement("div", {
    className: "cb-op-ft"
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    variant: "primary"
  }, "Learn more"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    variant: "ghost"
  }, "Dismiss")))))), /*#__PURE__*/React.createElement("div", {
    className: "cb-ag-sec",
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12,
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "t"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "wand-sparkles",
    size: 16,
    color: "var(--n-600)"
  }), "Skills"), /*#__PURE__*/React.createElement(__ds_scope.Card, {
    padding: 0,
    flat: true
  }, skills.map((sk, i) => /*#__PURE__*/React.createElement("div", {
    className: "cb-li",
    key: sk.name
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "scroll-text",
    size: 16,
    color: "var(--n-500)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "nm"
  }, sk.name), /*#__PURE__*/React.createElement("div", {
    className: "ds"
  }, sk.desc)), /*#__PURE__*/React.createElement(__ds_scope.Switch, {
    checked: sk.enabled,
    onChange: v => setSkills(skills.map((s, j) => j === i ? {
      ...s,
      enabled: v
    } : s))
  }))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "t"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "clock",
    size: 16,
    color: "var(--n-600)"
  }), "Scheduled", /*#__PURE__*/React.createElement(__ds_scope.Badge, null, "Beta"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    icon: "plus",
    onClick: () => setDlg(true)
  }, "New automation")), /*#__PURE__*/React.createElement(__ds_scope.Card, {
    padding: 0,
    flat: true
  }, __ds_scope.AUTOMATIONS.map(a => /*#__PURE__*/React.createElement("div", {
    className: "cb-li",
    key: a.name
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "calendar-clock",
    size: 16,
    color: "var(--n-500)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "nm"
  }, a.name), /*#__PURE__*/React.createElement("div", {
    className: "ds"
  }, a.freq, " \xB7 ", a.skill, " \u2192 ", a.output)), /*#__PURE__*/React.createElement(__ds_scope.Switch, {
    checked: a.active
  }))))))), /*#__PURE__*/React.createElement(__ds_scope.Dialog, {
    open: dlg,
    onClose: () => setDlg(false),
    title: "Create scheduled automation",
    width: 620,
    footerNote: "Scheduled automations may run with a small delay.",
    secondaryAction: {
      label: "Cancel",
      onClick: () => setDlg(false)
    },
    primaryAction: {
      label: "Create",
      onClick: () => setDlg(false)
    }
  }, /*#__PURE__*/React.createElement(FieldL, {
    label: "Name",
    req: true
  }, /*#__PURE__*/React.createElement(__ds_scope.Input, {
    placeholder: "Name your automation",
    width: "100%"
  })), /*#__PURE__*/React.createElement(FieldL, {
    label: "Description",
    req: true
  }, /*#__PURE__*/React.createElement(__ds_scope.Input, {
    placeholder: "Summary of what this automation does",
    width: "100%"
  })), /*#__PURE__*/React.createElement(FieldL, {
    label: "Instructions",
    req: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-xs)",
      color: "var(--text-muted)",
      marginBottom: 6
    }
  }, "Tell Cerebro what to do. Pick a skill below to run a predefined workflow."), /*#__PURE__*/React.createElement("textarea", {
    placeholder: "Describe what should happen each time the automation runs",
    style: {
      width: "100%",
      height: 96,
      resize: "vertical",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-sm)",
      color: "var(--text-primary)",
      border: "1px solid var(--n-300)",
      borderRadius: "var(--r-md)",
      padding: "8px 10px",
      outline: "none",
      boxSizing: "border-box"
    }
  })), /*#__PURE__*/React.createElement(FieldL, {
    label: "Skill"
  }, /*#__PURE__*/React.createElement(__ds_scope.Select, {
    width: "100%",
    options: [{
      value: "",
      label: "Search skills…"
    }, ...__ds_scope.SKILLS.map(s => ({
      value: s.name,
      label: s.name
    }))]
  })), /*#__PURE__*/React.createElement(FieldL, {
    label: "Default output location",
    req: true
  }, /*#__PURE__*/React.createElement(__ds_scope.Select, {
    width: "100%",
    options: [{
      value: "personal",
      label: "Personal section"
    }, {
      value: "space",
      label: "Field Platform space"
    }]
  })), /*#__PURE__*/React.createElement(FieldL, {
    label: "Scheduled frequency",
    req: true
  }, /*#__PURE__*/React.createElement(__ds_scope.SegmentedControl, {
    size: "md",
    value: freq,
    onChange: setFreq,
    options: [{
      value: "manual",
      label: "Manual"
    }, {
      value: "hourly",
      label: "Hourly"
    }, {
      value: "daily",
      label: "Daily"
    }, {
      value: "weekdays",
      label: "Weekdays"
    }, {
      value: "weekly",
      label: "Weekly"
    }]
  })), /*#__PURE__*/React.createElement(FieldL, {
    label: "Select time",
    req: true
  }, /*#__PURE__*/React.createElement(__ds_scope.Input, {
    width: 140,
    value: "09:00 AM",
    suffix: /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: "clock",
      size: 14
    })
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-xs)",
      color: "var(--text-muted)",
      marginTop: 6
    }
  }, "Times are shown in America/Los_Angeles."))));
}
Object.assign(__ds_scope, { AgentHome });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/AgentHome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/DeliveryBoard.jsx
try { (() => {
const css = `
.cb-kb{display:flex;gap:12px;padding:14px 20px 20px;align-items:flex-start;min-height:100%;background:var(--surface-board)}
.cb-kb-col{width:280px;flex:none;display:flex;flex-direction:column;gap:10px}
.cb-kb-colhd{display:flex;align-items:center;gap:8px;font-weight:600;font-size:var(--text-sm);color:var(--n-800);padding:0 2px}
.cb-kb-colhd .cb-kb-n{color:var(--n-400);font-weight:500;font-family:var(--font-mono);font-size:11px}
.cb-kb-add{border:1px dashed var(--n-300);border-radius:var(--r-lg);height:34px;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--n-500);font-size:var(--text-xs);cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-kb-add:hover{background:var(--n-50);color:var(--n-700)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-kb-css")) {
  const t = document.createElement("style");
  t.id = "cb-kb-css";
  t.textContent = css;
  document.head.appendChild(t);
}
const LABELS = {
  idea: "New idea",
  planned: "Planned",
  progress: "In progress",
  validation: "Validation",
  released: "Released"
};
function DeliveryBoard({
  onSelect,
  onControls
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-view"
  }, /*#__PURE__*/React.createElement(__ds_scope.BoardHeader, {
    crumb: "Organization",
    icon: "kanban",
    title: "Delivery board",
    onControls: onControls
  }, /*#__PURE__*/React.createElement(__ds_scope.DefaultChips, null)), /*#__PURE__*/React.createElement("div", {
    className: "cb-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-kb"
  }, __ds_scope.DELIVERY.map(col => /*#__PURE__*/React.createElement("div", {
    className: "cb-kb-col",
    key: col.status
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-kb-colhd"
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusFlag, {
    bare: true,
    status: col.status
  }), LABELS[col.status], /*#__PURE__*/React.createElement("span", {
    className: "cb-kb-n"
  }, col.cards.length), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "plus",
    label: "Add feature",
    size: "sm"
  })), col.cards.map(c => /*#__PURE__*/React.createElement(__ds_scope.KanbanCard, {
    key: c.title,
    title: c.title,
    swatch: c.swatch,
    timeframe: c.timeframe,
    owner: c.owner,
    tags: c.tags,
    onClick: () => onSelect({
      id: c.title,
      name: c.title,
      kind: "feature",
      status: col.status,
      owner: c.owner,
      timeframe: c.timeframe,
      swatch: c.swatch,
      insights: 2,
      release: (c.tags || []).some(t => t.icon === "flag") ? c.tags.find(t => t.icon === "flag").label : null
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-kb-add"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "plus",
    size: 14
  }), "Add feature"))), /*#__PURE__*/React.createElement("div", {
    className: "cb-kb-col",
    style: {
      width: 200
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-kb-add",
    style: {
      height: 30
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "plus",
    size: 14
  }), "Add column")))));
}
Object.assign(__ds_scope, { DeliveryBoard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/DeliveryBoard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/KnowledgeView.jsx
try { (() => {
const css = `
.cb-kn{flex:1;display:flex;min-width:0;min-height:0}
.cb-kn-list{flex:1;min-width:0;overflow-y:auto;border-top:1px solid var(--n-200)}
.cb-sig{display:flex;flex-direction:column;gap:4px;padding:12px 20px;border-bottom:1px solid var(--n-100);cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-sig:hover{background:var(--n-50)}
.cb-sig-on{background:var(--surface-selected)}
.cb-sig-on:hover{background:var(--surface-selected)}
.cb-sig-hd{display:flex;align-items:center;gap:8px}
.cb-sig-hd .cb-sig-team{font-weight:600;color:var(--n-900)}
.cb-sig-hd .cb-sig-meta{color:var(--n-500);font-size:var(--text-xs)}
.cb-sig-txt{color:var(--n-600);font-size:var(--text-xs);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-sig-dot{width:7px;height:7px;border-radius:50%;background:var(--cortex-500);flex:none}
.cb-kn-detail{width:420px;flex:none;border-left:1px solid var(--n-200);border-top:1px solid var(--n-200);display:flex;flex-direction:column;min-height:0;background:var(--n-0)}
.cb-kn-detail-bd{flex:1;overflow-y:auto;padding:16px 20px}
.cb-kn-f{display:flex;gap:8px;min-height:30px;align-items:center;font-size:var(--text-sm)}
.cb-kn-f .k{display:flex;align-items:center;gap:8px;width:110px;flex:none;color:var(--n-500)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-kn-css")) {
  const t = document.createElement("style");
  t.id = "cb-kn-css";
  t.textContent = css;
  document.head.appendChild(t);
}
function KnowledgeView({
  onControls
}) {
  const [sel, setSel] = React.useState(__ds_scope.SIGNALS[0].id);
  const s = __ds_scope.SIGNALS.find(x => x.id === sel);
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-view"
  }, /*#__PURE__*/React.createElement(__ds_scope.BoardHeader, {
    crumb: "Library",
    icon: "message-square-text",
    title: "Knowledge",
    onControls: onControls
  }, /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    label: "All signals",
    active: true
  }), /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    label: "Unprocessed"
  }), /*#__PURE__*/React.createElement(__ds_scope.FilterChip, {
    icon: "list-filter",
    label: "Filtered by",
    value: "Any time",
    onRemove: () => {}
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.Input, {
    icon: "search",
    placeholder: "Search knowledge\u2026",
    width: 220,
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    className: "cb-kn"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-kn-list"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 20px",
      fontSize: "var(--text-xs)",
      color: "var(--n-500)",
      borderBottom: "1px solid var(--n-100)",
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, __ds_scope.SIGNALS.length, " signals", /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "arrow-down-up",
    size: 12
  }), "Updated (newest)"), __ds_scope.SIGNALS.map(sg => /*#__PURE__*/React.createElement("div", {
    key: sg.id,
    className: `cb-sig ${sel === sg.id ? "cb-sig-on" : ""}`,
    onClick: () => setSel(sg.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-sig-hd"
  }, /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: "company",
    size: 15
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-sig-team"
  }, sg.team), /*#__PURE__*/React.createElement("span", {
    className: "cb-sig-meta"
  }, sg.author), /*#__PURE__*/React.createElement(__ds_scope.Badge, null, sg.kind), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-sig-meta"
  }, sg.time), sg.unread ? /*#__PURE__*/React.createElement("span", {
    className: "cb-sig-dot"
  }) : null), /*#__PURE__*/React.createElement("div", {
    className: "cb-sig-txt"
  }, sg.text)))), /*#__PURE__*/React.createElement("div", {
    className: "cb-kn-detail"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4,
      padding: "10px 12px 0"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, null, s.kind), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "maximize-2",
    label: "Expand",
    size: "sm"
  }), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "ellipsis",
    label: "More",
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 20px 12px",
      fontSize: "var(--text-lg)",
      fontWeight: 600,
      letterSpacing: "var(--track-tight)"
    }
  }, s.kind, " \u2014 ", s.team), /*#__PURE__*/React.createElement("div", {
    className: "cb-kn-detail-bd"
  }, /*#__PURE__*/React.createElement(__ds_scope.AISummary, {
    sources: s.sources,
    onRegenerate: () => {}
  }, s.summary), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "16px 0 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-kn-f"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "building-2",
    size: 14
  }), "Team"), /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: "company",
    size: 14
  }), /*#__PURE__*/React.createElement("span", null, s.team)), /*#__PURE__*/React.createElement("div", {
    className: "cb-kn-f"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "circle-user",
    size: 14
  }), "From"), /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: s.author,
    size: 20
  }), /*#__PURE__*/React.createElement("span", null, s.author)), /*#__PURE__*/React.createElement("div", {
    className: "cb-kn-f"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "link",
    size: 14
  }), "Links"), s.linked ? /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    icon: s.linked.type === "feature" ? undefined : s.linked.type === "initiative" ? "diamond" : "lightbulb",
    color: s.linked.swatch
  }, s.linked.label) : /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--n-400)"
    }
  }, "None"))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18,
      paddingTop: 14,
      borderTop: "1px solid var(--n-100)",
      color: "var(--n-700)",
      lineHeight: "20px",
      fontSize: "var(--text-sm)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: "var(--n-900)"
    }
  }, s.author, ":"), " ", s.text)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "12px 16px",
      borderTop: "1px solid var(--n-100)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: "Maya Chen",
    size: 22
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      color: "var(--n-500)"
    }
  }, "Following"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    icon: "check"
  }, "Mark processed")))));
}
Object.assign(__ds_scope, { KnowledgeView });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/KnowledgeView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/OkrBoard.jsx
try { (() => {
const W = {
  tf: 180,
  owner: 150,
  health: 120,
  prog: 170
};
function Head() {
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-grid-head"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "target",
    size: 13
  }), "Objectives, Key results"), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.tf,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "calendar",
    size: 13
  }), "Timeframe"), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.owner,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "briefcase",
    size: 13
  }), "Owner"), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.health,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "activity",
    size: 13
  }), "Health"), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.prog,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "percent",
    size: 13
  }), "Work progress"));
}
function OkrBoard({
  onSelect,
  selectedId,
  onControls
}) {
  const [open, setOpen] = React.useState({
    "obj-1": true,
    "obj-2": true,
    "obj-3": false
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-view"
  }, /*#__PURE__*/React.createElement(__ds_scope.BoardHeader, {
    crumb: "Organization",
    icon: "table-2",
    title: "Strategic OKR planning",
    onControls: onControls
  }, /*#__PURE__*/React.createElement(__ds_scope.DefaultChips, null)), /*#__PURE__*/React.createElement("div", {
    className: "cb-body"
  }, /*#__PURE__*/React.createElement(Head, null), __ds_scope.OBJECTIVES.map(o => /*#__PURE__*/React.createElement(React.Fragment, {
    key: o.id
  }, /*#__PURE__*/React.createElement("div", {
    className: `cb-row ${selectedId === o.id ? "cb-row-on" : ""}`,
    onClick: () => onSelect({
      ...o,
      kind: "objective",
      insights: 4
    })
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-cell-name"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-right",
    size: 14,
    className: `cb-chev ${open[o.id] ? "cb-chev-open" : ""}`,
    onClick: e => {
      e.stopPropagation();
      setOpen(s => ({
        ...s,
        [o.id]: !s[o.id]
      }));
    }
  }), /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: "objective",
    size: 16
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-name-txt"
  }, o.name)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.tf,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "cb-mono"
  }, o.timeframe)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.owner,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: o.owner,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, o.owner)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.health,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: o.health,
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.prog,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.ProgressBar, {
    value: o.progress,
    width: 100,
    showLabel: true
  }))), open[o.id] ? o.krs.map(kr => /*#__PURE__*/React.createElement("div", {
    key: kr.id,
    className: `cb-row ${selectedId === kr.id ? "cb-row-on" : ""}`,
    onClick: () => onSelect({
      ...kr,
      kind: "keyResult",
      insights: 1,
      description: `Current: ${kr.current}.`
    })
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-cell-name",
    style: {
      paddingLeft: 46,
      fontWeight: 400
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: "keyResult",
    size: 15
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-name-txt"
  }, kr.name), /*#__PURE__*/React.createElement("span", {
    className: "cb-mono",
    style: {
      color: "var(--n-400)"
    }
  }, kr.current)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.tf,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "cb-mono"
  }, kr.timeframe)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.owner,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: kr.owner,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, kr.owner)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.health,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.HealthChip, {
    health: kr.health,
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: W.prog,
      flex: "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.ProgressBar, {
    value: kr.progress,
    width: 100,
    showLabel: true
  })))) : null)), /*#__PURE__*/React.createElement("div", {
    className: "cb-addrow"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "plus",
    size: 15
  }), "Create objective")));
}
Object.assign(__ds_scope, { OkrBoard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/OkrBoard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/RoadmapView.jsx
try { (() => {
const css = `
.cb-tl{display:flex;flex-direction:column;min-width:860px}
.cb-tl-head{display:flex;height:var(--row-head-h);border-top:1px solid var(--n-200);border-bottom:1px solid var(--n-200);background:var(--n-25);position:sticky;top:0;z-index:2;font-size:var(--text-xs);color:var(--n-600)}
.cb-tl-names{width:300px;flex:none;display:flex;align-items:center;padding:0 12px;border-right:1px solid var(--n-200);gap:6px;font-weight:500}
.cb-tl-months{flex:1;display:grid;grid-template-columns:repeat(8,1fr)}
.cb-tl-months>div{display:flex;align-items:center;padding:0 8px;border-right:1px solid var(--n-100);text-transform:uppercase;letter-spacing:.04em;font-size:10px;gap:6px}
.cb-tl-q{color:var(--n-800);font-weight:600}
.cb-tl-row{display:flex;border-bottom:1px solid var(--n-100);cursor:pointer}
.cb-tl-row:hover{background:var(--n-50)}
.cb-tl-row .cb-tl-names{font-weight:500;color:var(--n-900);gap:8px;border-right:1px solid var(--n-200)}
.cb-tl-canvas{flex:1;position:relative;display:grid;grid-template-columns:repeat(8,1fr);align-items:center}
.cb-tl-canvas>i{border-right:1px solid var(--n-100);height:100%;grid-row:1}
.cb-tl-bar{height:8px;border-radius:var(--r-full);grid-row:1;margin:0 6px;position:relative}
.cb-tl-bar-thin{height:6px}
.cb-tl-grp{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:var(--n-25);border-bottom:1px solid var(--n-100);font-weight:600;font-size:var(--text-sm);color:var(--n-800)}
.cb-tl-today{position:absolute;top:0;bottom:0;width:1px;background:var(--cortex-400);z-index:1;pointer-events:none}
.cb-tl-today::after{content:"";position:absolute;top:0;left:-3px;width:7px;height:7px;border-radius:50%;background:var(--cortex-400)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tl-css")) {
  const t = document.createElement("style");
  t.id = "cb-tl-css";
  t.textContent = css;
  document.head.appendChild(t);
}
const M0 = 4; // May
function Row({
  item,
  kind,
  indent,
  onClick
}) {
  const start = item.start - M0 + 1,
    end = Math.min(start + item.len, 9);
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-row",
    style: {
      height: 40
    },
    onClick: onClick
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-names",
    style: {
      paddingLeft: 12 + (indent ? 26 : 0),
      fontWeight: indent ? 400 : 500
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.EntityIcon, {
    type: kind,
    swatch: item.swatch,
    size: 15
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, item.name)), /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-canvas"
  }, Array.from({
    length: 8
  }).map((_, i) => /*#__PURE__*/React.createElement("i", {
    key: i,
    style: {
      gridColumn: i + 1
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: `cb-tl-bar ${indent ? "cb-tl-bar-thin" : ""}`,
    style: {
      gridColumn: `${start} / ${end}`,
      background: item.swatch
    }
  })));
}
function RoadmapView({
  onSelect,
  onControls
}) {
  const groups = [{
    label: "In progress",
    status: "progress",
    items: __ds_scope.INITIATIVES.filter(i => i.status === "progress")
  }, {
    label: "Planned",
    status: "planned",
    items: __ds_scope.INITIATIVES.filter(i => i.status === "planned")
  }, {
    label: "New idea",
    status: "idea",
    items: __ds_scope.INITIATIVES.filter(i => i.status === "idea")
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "cb-view"
  }, /*#__PURE__*/React.createElement(__ds_scope.BoardHeader, {
    crumb: "Organization",
    icon: "calendar-range",
    title: "Initiatives roadmap",
    onControls: onControls
  }, /*#__PURE__*/React.createElement(__ds_scope.DefaultChips, null)), /*#__PURE__*/React.createElement("div", {
    className: "cb-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-tl",
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-names"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "diamond",
    size: 13
  }), "Initiatives, Features"), /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-months"
  }, __ds_scope.MONTHS.slice(M0, M0 + 8).map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: m
  }, m === "Jul" ? /*#__PURE__*/React.createElement("span", {
    className: "cb-tl-q"
  }, "Q3 2026") : m === "Oct" ? /*#__PURE__*/React.createElement("span", {
    className: "cb-tl-q"
  }, "Q4") : null, m)))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: `calc(300px + (100% - 300px) * ${(2 + 19 / 31) / 8})`,
      top: 36,
      bottom: 0
    },
    className: "cb-tl-today"
  }), groups.map(g => /*#__PURE__*/React.createElement(React.Fragment, {
    key: g.label
  }, /*#__PURE__*/React.createElement("div", {
    className: "cb-tl-grp"
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusFlag, {
    bare: true,
    status: g.status
  }), g.label), g.items.map(init => /*#__PURE__*/React.createElement(React.Fragment, {
    key: init.id
  }, /*#__PURE__*/React.createElement(Row, {
    item: init,
    kind: "initiative",
    onClick: () => onSelect({
      ...init,
      kind: "initiative",
      insights: 3,
      team: "Field Platform"
    })
  }), init.features.map(f => /*#__PURE__*/React.createElement(Row, {
    key: f.id,
    item: f,
    kind: "feature",
    indent: true,
    onClick: () => onSelect({
      ...f,
      kind: "feature",
      insights: 2,
      timeframe: init.timeframe,
      objective: init.objective
    })
  })))))), /*#__PURE__*/React.createElement("div", {
    className: "cb-addrow"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "plus",
    size: 15
  }), "Create initiative"))));
}
Object.assign(__ds_scope, { RoadmapView });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/RoadmapView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cerebro/CerebroApp.jsx
try { (() => {
const ALIAS = {
  objectives: "okr",
  initiatives: "roadmap",
  features: "delivery",
  opportunities: "agenthome",
  home: "okr"
};
const LAYOUT_VIEW = {
  grid: "okr",
  timeline: "roadmap",
  columns: "delivery"
};
const VIEW_LAYOUT = {
  okr: "grid",
  roadmap: "timeline",
  delivery: "columns"
};
function CerebroApp({
  initialView = "okr"
}) {
  const [view, setView] = React.useState(initialView);
  const [item, setItem] = React.useState(null);
  const [controls, setControls] = React.useState(false);
  const navigate = id => {
    setView(ALIAS[id] || id);
    setItem(null);
    setControls(false);
  };
  const select = it => {
    setControls(false);
    setItem(it);
  };
  const openControls = () => {
    setItem(null);
    setControls(true);
  };
  const props = {
    onSelect: select,
    selectedId: item && item.id,
    onControls: openControls
  };
  return /*#__PURE__*/React.createElement(__ds_scope.AppShell, {
    active: view,
    onNavigate: navigate
  }, view === "okr" ? /*#__PURE__*/React.createElement(__ds_scope.OkrBoard, props) : view === "roadmap" ? /*#__PURE__*/React.createElement(__ds_scope.RoadmapView, props) : view === "delivery" ? /*#__PURE__*/React.createElement(__ds_scope.DeliveryBoard, props) : view === "knowledge" ? /*#__PURE__*/React.createElement(__ds_scope.KnowledgeView, {
    onControls: openControls
  }) : /*#__PURE__*/React.createElement(__ds_scope.AgentHome, null), item ? /*#__PURE__*/React.createElement(__ds_scope.DetailPanel, {
    item: item,
    onClose: () => setItem(null)
  }) : null, controls ? /*#__PURE__*/React.createElement(__ds_scope.BoardControls, {
    layout: VIEW_LAYOUT[view] || "grid",
    onLayout: l => setView(LAYOUT_VIEW[l]),
    onClose: () => setControls(false)
  }) : null);
}
Object.assign(__ds_scope, { CerebroApp });
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/cerebro/CerebroApp.jsx", error: String((e && e.message) || e) }); }

__ds_ns.AISummary = __ds_scope.AISummary;

__ds_ns.AskBar = __ds_scope.AskBar;

__ds_ns.KanbanCard = __ds_scope.KanbanCard;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.SegmentedControl = __ds_scope.SegmentedControl;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.AvatarGroup = __ds_scope.AvatarGroup;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.EntityIcon = __ds_scope.EntityIcon;

__ds_ns.HealthChip = __ds_scope.HealthChip;

__ds_ns.ProgressBar = __ds_scope.ProgressBar;

__ds_ns.StatusFlag = __ds_scope.StatusFlag;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.EmptyState = __ds_scope.EmptyState;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.FilterChip = __ds_scope.FilterChip;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.AgentHome = __ds_scope.AgentHome;

__ds_ns.NAV = __ds_scope.NAV;

__ds_ns.AppShell = __ds_scope.AppShell;

__ds_ns.BoardHeader = __ds_scope.BoardHeader;

__ds_ns.DefaultChips = __ds_scope.DefaultChips;

__ds_ns.BoardControls = __ds_scope.BoardControls;

__ds_ns.CerebroApp = __ds_scope.CerebroApp;

__ds_ns.DeliveryBoard = __ds_scope.DeliveryBoard;

__ds_ns.DetailPanel = __ds_scope.DetailPanel;

__ds_ns.KnowledgeView = __ds_scope.KnowledgeView;

__ds_ns.OkrBoard = __ds_scope.OkrBoard;

__ds_ns.RoadmapView = __ds_scope.RoadmapView;

__ds_ns.PEOPLE = __ds_scope.PEOPLE;

__ds_ns.OBJECTIVES = __ds_scope.OBJECTIVES;

__ds_ns.INITIATIVES = __ds_scope.INITIATIVES;

__ds_ns.MONTHS = __ds_scope.MONTHS;

__ds_ns.DELIVERY = __ds_scope.DELIVERY;

__ds_ns.SIGNALS = __ds_scope.SIGNALS;

__ds_ns.OPPORTUNITIES = __ds_scope.OPPORTUNITIES;

__ds_ns.SKILLS = __ds_scope.SKILLS;

__ds_ns.AUTOMATIONS = __ds_scope.AUTOMATIONS;

})();
