window.__ModuleLoader__.load({
	id: "dsh-session-autarchive",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/entry.jsx
var entry_exports = {};
__export(entry_exports, {
  AutoArchiveRow: () => AutoArchiveRow,
  AutoArchiveToggleRow: () => AutoArchiveToggleRow,
  ProtectHover: () => ProtectHover,
  ProtectLeading: () => ProtectLeading,
  ProtectMenuItem: () => ProtectMenuItem,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(entry_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var ROUTE = "dsh-session-autarchive/api";
var TICK_MS = 5 * 60 * 1e3;
var MAX_PER_TICK = 60;
function api(path) {
  const relative = String(path).replace(/^\/+/, "");
  if (typeof document === "undefined") return "/" + relative;
  return new URL(relative, document.baseURI).pathname;
}
async function call(method, path, body) {
  const res = await fetch(api(path), {
    method,
    headers: body ? { "content-type": "application/json" } : { accept: "application/json" },
    body: body ? JSON.stringify(body) : void 0
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) throw new Error(data && data.error || "HTTP " + res.status);
  return data;
}
var store = {
  enabled: true,
  days: 5,
  protected: /* @__PURE__ */ new Set(),
  candidates: []
};
var listeners = /* @__PURE__ */ new Set();
function emit() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
    }
  }
}
function patchStore(next) {
  Object.assign(store, next);
  emit();
}
function useStore() {
  const [, bump] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return store;
}
async function pull() {
  const data = await call("GET", ROUTE + "/state");
  patchStore({
    enabled: data.enabled !== false,
    days: Number(data.days) > 0 ? Number(data.days) : 5,
    // 名单字段缺失（宿主没回、老版本回包）时保留本地这份：宁可多显示盾牌，也不整片清空
    protected: Array.isArray(data.protected) ? new Set(data.protected) : store.protected,
    candidates: Array.isArray(data.candidates) ? data.candidates : []
  });
  return data;
}
function archiveChannel(ctx) {
  try {
    const found = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : void 0;
    return found && typeof found.archiveSession === "function" ? found : void 0;
  } catch {
    return void 0;
  }
}
async function runOnce(ctx) {
  const workspace = archiveChannel(ctx);
  const data = await pull();
  if (!workspace || !data.enabled || !Array.isArray(data.candidates) || data.candidates.length === 0) return;
  let done = 0;
  for (const item of data.candidates.slice(0, MAX_PER_TICK)) {
    if (store.protected.has(item.id)) continue;
    try {
      await workspace.archiveSession(item.id);
      done += 1;
    } catch {
    }
  }
  if (done > 0) await pull();
}
async function toggleProtect(sessionId, protectedNow) {
  const data = await call("POST", ROUTE + "/protect", { sessionId, protected: protectedNow });
  patchStore({ protected: Array.isArray(data.protected) ? new Set(data.protected) : store.protected });
}
function ShieldIcon({ size = 14 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      focusable: "false",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M12 3l7 2.6v5.2c0 4.3-3 8.2-7 9.4-4-1.2-7-5.1-7-9.4V5.6L12 3z" })
    }
  );
}
var ITEM = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  width: "100%",
  minHeight: "34px",
  padding: "6px 8px",
  border: "none",
  borderRadius: "var(--dsw-radius-md)",
  background: "transparent",
  cursor: "pointer",
  fontSize: "13px",
  lineHeight: "20px",
  color: "var(--dsw-alias-label-primary)",
  textAlign: "left",
  fontFamily: "inherit"
};
var ITEM_ICON = {
  display: "inline-flex",
  flex: "none",
  width: "14px",
  height: "14px",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--dsw-alias-menu-icon)"
};
var noopMenuHook = () => [false, () => {
}];
function ProtectMenuItem(props) {
  const { sessionId } = props;
  const state = useStore();
  const menuHook = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState : noopMenuHook;
  const [, setMenuOpen] = menuHook();
  const [hover, setHover] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const on = state.protected.has(sessionId);
  const click = () => {
    setMenuOpen(false);
    setBusy(true);
    void toggleProtect(sessionId, !on).catch(() => {
    }).finally(() => setBusy(false));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      type: "button",
      role: "menuitem",
      disabled: busy,
      onClick: click,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        ...ITEM,
        background: hover && !busy ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        opacity: busy ? 0.4 : 1
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", style: { ...ITEM_ICON, color: on ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-menu-icon)" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShieldIcon, {}) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: on ? "\u53D6\u6D88\u300C\u4E0D\u81EA\u52A8\u5F52\u6863\u300D" : "\u4E0D\u81EA\u52A8\u5F52\u6863" })
      ]
    }
  );
}
function ProtectLeading(props) {
  const state = useStore();
  if (!state.protected.has(props.sessionId)) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { title: "\u4E0D\u4F1A\u88AB\u81EA\u52A8\u5F52\u6863", "aria-label": "\u4E0D\u4F1A\u88AB\u81EA\u52A8\u5F52\u6863", style: ITEM_ICON, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShieldIcon, {}) });
}
function ProtectHover(props) {
  const state = useStore();
  if (!state.protected.has(props.sessionId)) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-caption)" }, children: "\u4E0D\u4F1A\u88AB\u81EA\u52A8\u5F52\u6863" });
}
var ROW_CSS = `
.zsa-item { display:flex; align-items:center; gap:8px; padding:16px 0; border-bottom:0.5px solid var(--dsw-alias-border-l2); }
.zsa-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; padding-right:24px; }
.zsa-title { font-size:14px; font-weight:400; line-height:22px; color:var(--dsw-alias-label-primary); }
.zsa-desc { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.zsa-field { flex:none; display:flex; align-items:center; gap:8px; }
.zsa-input { width:88px; height:36px; padding:0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; text-align:center; }
.zsa-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.zsa-unit { font-size:12px; color:var(--dsw-alias-label-secondary); }
.zsa-error { font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
`;
function Switch({ on, disabled, onChange }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": on,
      "aria-label": on ? "\u5173\u95ED\u81EA\u52A8\u5F52\u6863" : "\u5F00\u542F\u81EA\u52A8\u5F52\u6863",
      disabled,
      onClick: () => onChange(!on),
      style: {
        width: 36,
        height: 20,
        flex: "none",
        border: 0,
        borderRadius: 10,
        padding: 0,
        cursor: disabled ? "default" : "pointer",
        position: "relative",
        background: on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l1)",
        opacity: disabled ? 0.5 : 1,
        transition: "background .15s"
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: {
        position: "absolute",
        top: 2,
        left: on ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: 8,
        background: "#fff",
        transition: "left .15s"
      } })
    }
  );
}
function AutoArchiveToggleRow() {
  const state = useStore();
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const on = state.enabled !== false;
  const toggle = async (next) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await call("POST", ROUTE + "/config", { enabled: next });
      patchStore({ enabled: data.enabled !== false });
    } catch (err) {
      setError("\u6CA1\u4FDD\u5B58\u4E0A\uFF1A" + String(err && err.message || err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "zsa-item", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: ROW_CSS }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "zsa-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-title", children: "\u81EA\u52A8\u5F52\u6863" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-desc", children: "\u5173\u95ED\u540E\u540E\u53F0\u4E0D\u518D\u81EA\u52A8\u5F52\u6863\uFF1B\u624B\u52A8\u6267\u884C\u4ECD\u7136\u53EF\u7528\u3002\u5F53\u524D\u5019\u9009 " + state.candidates.length + " \u4E2A\u3002" }),
      error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-error", role: "alert", children: error }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-field", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Switch, { on, disabled: busy, onChange: (next) => void toggle(next) }) })
  ] });
}
function AutoArchiveRow() {
  const state = useStore();
  const [draft, setDraft] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [loaded, setLoaded] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    void pull().then(() => setLoaded(true)).catch(() => {
    });
  }, []);
  const value = draft === null ? String(state.days) : draft;
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650;
  const commit = async () => {
    if (draft === null || busy) return;
    if (!valid) {
      setError("\u5929\u6570\u8981\u662F 1\uFF5E3650 \u7684\u6574\u6570");
      setDraft(null);
      return;
    }
    if (parsed === state.days) {
      setDraft(null);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await call("POST", ROUTE + "/config", { days: parsed });
      patchStore({ days: Number(data.days) > 0 ? Number(data.days) : parsed });
      setDraft(null);
    } catch (err) {
      setError("\u6CA1\u4FDD\u5B58\u4E0A\uFF1A" + String(err && err.message || err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "zsa-item", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: ROW_CSS }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "zsa-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-title", children: "\u81EA\u52A8\u5F52\u6863\u5929\u6570" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-desc", children: "\u8D85\u8FC7\u8FD9\u4E2A\u5929\u6570\u6CA1\u6709\u6D3B\u52A8\u7684\u4F1A\u8BDD\u4F1A\u88AB\u81EA\u52A8\u5F52\u6863\uFF08\u5DF2\u5F52\u6863\u3001\u7F6E\u9876\u3001\u6807\u8BB0\u300C\u4E0D\u81EA\u52A8\u5F52\u6863\u300D\u7684\u8DF3\u8FC7\uFF09\u3002\u5F53\u524D\u5019\u9009 " + (loaded ? state.candidates.length : "\u2014") + " \u4E2A\u3002" }),
      error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "zsa-error", role: "alert", children: error }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "zsa-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          className: "zsa-input",
          type: "number",
          min: 1,
          max: 3650,
          step: 1,
          value,
          disabled: busy || state.enabled === false,
          "aria-label": "\u81EA\u52A8\u5F52\u6863\u5929\u6570",
          onChange: (event) => {
            setDraft(event.target.value);
            setError(null);
          },
          onBlur: () => {
            void commit();
          },
          onKeyDown: (event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(null);
              setError(null);
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "zsa-unit", children: "\u5929" })
    ] })
  ] });
}
var inject = ["slots"];
function apply(ctx) {
  try {
    const tick = () => {
      void runOnce(ctx).catch(() => {
      });
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    try {
      if (typeof ctx.effect === "function") ctx.effect(() => () => clearInterval(timer));
    } catch {
    }
  } catch {
  }
  place(ctx, "sidebar.workspaces.session.menu.item", 450, ProtectMenuItem);
  place(ctx, "sidebar.session.row.leading", 100, ProtectLeading);
  place(ctx, "sidebar.session.row.hover", 100, ProtectHover);
  try {
    ctx.slots.inject("settings.general.item", () => ctx.slots.register({
      name: "settings.general.item",
      id: "session-autarchive-enabled",
      order: 94
    }, AutoArchiveToggleRow));
    ctx.slots.inject("settings.general.item", () => ctx.slots.register({
      name: "settings.general.item",
      id: "session-autarchive-days",
      order: 95
    }, AutoArchiveRow));
  } catch {
  }
}
function place(ctx, slot, order, Component) {
  try {
    ctx.slots.inject(slot, () => ctx.slots.register({
      name: slot,
      id: "dsh-session-autarchive-" + slot.replace(/\./g, "-"),
      order
    }, Component));
  } catch {
  }
}

		return module.exports;
	}
});
