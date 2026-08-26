/**
 * dsh-manual-compact — browser face.
 *
 * Hand-written loader module mirroring the in-repo client bundle format
 * (window.__ModuleLoader__.load with a CommonJS factory) — no JSX, no
 * bundler, no TS. React is required through the app's module table.
 *
 * Two contributions:
 * 1. `conversation.input.contextMeterPanel` — the manual-compaction section
 *    inside the context meter popup (DSH builds that declare the slot).
 * 2. `conversation.input.right` — a small composer button with the same panel
 *    in a popup, registered only when the meter-panel slot is absent.
 *
 * Both read and write the `manual-compact` settings namespace through the
 * shared `ctx.settingsScope` transport; the host executes the compaction and
 * publishes the outcome into `lastRun`.
 */

window.__ModuleLoader__.load({
  id: "dsh-manual-compact-plugin/client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var useSyncExternalStore = react.useSyncExternalStore;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var CSS_ID = "dsh-manual-compact-plugin/client";
    var css = [
      ".dsmc-title{font-weight:600;margin:10px 0 6px;font-size:12px;color:var(--dsw-alias-label-primary)}",
      ".dsmc-sep{border:0;border-top:1px solid var(--dsw-alias-border-l3);margin:8px 0}",
      ".dsmc-row{display:flex;align-items:center;gap:6px;margin:6px 0}",
      ".dsmc-row label{flex:none;min-width:52px;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsmc-row select,.dsmc-row input{box-sizing:border-box;min-width:0;flex:1;padding:4px 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);font-size:12px}",
      ".dsmc-actions{display:flex;justify-content:flex-end;margin-top:8px}",
      ".dsmc-actions button{border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}",
      ".dsmc-actions button:disabled{cursor:default;opacity:.6}",
      ".dsmc-confirm{background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-color)}",
      ".dsmc-msg{margin-top:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".dsmc-msg.dsmc-err{color:var(--dsw-alias-state-error-primary)}",
      ".dsmc-archive{max-height:160px;overflow:auto}",
      ".dsmc-arch-item{border:0;background:transparent;width:100%;text-align:left;padding:4px 0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsmc-arch-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsmc-arch-summary{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);margin:4px 0 8px;white-space:pre-wrap}",
      ".dsmc-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".dsmc-wrap{position:relative;display:inline-flex}",
      ".dsmc-btn{height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
      ".dsmc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsmc-pop{position:absolute;right:0;bottom:32px;z-index:120;width:280px;max-height:440px;overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:12px;text-align:left}",
    ].join("");
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-manual-compact-plugin";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /**
     * Read the `manual-compact` namespace snapshot reactively.
     * @param scope - the bound SettingsScope.
     * @returns `{ value, writable, ready }`.
     */
    function useNamespaceSnapshot(scope) {
      var snapshot = useSyncExternalStore(
        function (onChange) { return scope.subscribe(onChange); },
        function () { return scope.getSnapshot(); }
      );
      var ready = snapshot.status === "ready" && snapshot.value !== undefined;
      return {
        value: ready ? snapshot.value : undefined,
        writable: snapshot.writable === true && ready,
        ready: snapshot.status === "ready",
      };
    }

    function fmtTime(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "";
      var d = new Date(ms);
      var pad = function (v) { return String(v).padStart(2, "0"); };
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function fmtTokens(v) {
      if (typeof v !== "number" || !isFinite(v)) return "?";
      if (v >= 1000) return Math.round(v / 1000) + "k";
      return String(v);
    }

    /**
     * The shared controls: keep selector, mode selector, submit, last result,
     * and the landed compaction archive read from the conversation snapshot.
     */
    function CompactControls(props) {
      var state = useNamespaceSnapshot(props.scope);
      var value = state.value || {};
      var [keep, setKeep] = useState("5");
      var [customKeep, setCustomKeep] = useState("");
      var [mode, setMode] = useState("stop");
      var [localError, setLocalError] = useState("");
      var [expandedSeq, setExpandedSeq] = useState(null);

      var request = value.request;
      var busy = request !== null && request !== undefined;
      var lastRun = value.lastRun;

      var legacy = props.session && props.session.chat && props.session.chat.legacy;
      var nodes = legacy && Array.isArray(legacy.nodes) ? legacy.nodes : [];
      var entries = [];
      for (var i = nodes.length - 1; i >= 0; i -= 1) {
        var n = nodes[i];
        if (n && n.kind === "compaction") entries.push(n);
      }

      var effectiveKeep = keep === "custom" ? customKeep : keep;
      function submit() {
        var n = Number(effectiveKeep);
        if (!Number.isInteger(n) || n < 1) {
          setLocalError("请输入大于 0 的保留数量。");
          return;
        }
        setLocalError("");
        if (props.sessionId === undefined || props.sessionId === null) {
          setLocalError("当前没有可压缩的会话。");
          return;
        }
        props.scope.set("request", {
          nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
          sessionId: props.sessionId,
          keep: n,
          mode: mode,
        }).catch(function (error) {
          console.error("[dsh-manual-compact-plugin] submit failed:", error);
          setLocalError("请求发送失败，请稍后重试。");
        });
      }

      return react.createElement(
        "div",
        { className: "dsmc", "data-manual-compact": true },
        react.createElement("hr", { className: "dsmc-sep" }),
        react.createElement("div", { className: "dsmc-title" }, "手动压缩"),
        react.createElement(
          "div",
          { className: "dsmc-row" },
          react.createElement("label", null, "保留最近"),
          react.createElement(
            "select",
            { value: keep, disabled: busy, onChange: function (e) { setKeep(e.target.value); } },
            react.createElement("option", { value: "1" }, "1 条"),
            react.createElement("option", { value: "3" }, "3 条"),
            react.createElement("option", { value: "5" }, "5 条（推荐）"),
            react.createElement("option", { value: "10" }, "10 条"),
            react.createElement("option", { value: "20" }, "20 条"),
            react.createElement("option", { value: "50" }, "50 条"),
            react.createElement("option", { value: "custom" }, "自定义")
          )
        ),
        keep === "custom"
          ? react.createElement("input", {
            type: "number",
            min: 1,
            max: 10000,
            placeholder: "输入数量",
            disabled: busy,
            onChange: function (e) { setCustomKeep(e.target.value); },
          })
          : null,
        react.createElement(
          "div",
          { className: "dsmc-row" },
          react.createElement("label", null, "处理方式"),
          react.createElement(
            "select",
            { value: mode, disabled: busy, onChange: function (e) { setMode(e.target.value); } },
            react.createElement("option", { value: "stop" }, "完成一批后停止"),
            react.createElement("option", { value: "batch" }, "分批处理直到完成")
          )
        ),
        react.createElement(
          "div",
          { className: "dsmc-actions" },
          react.createElement(
            "button",
            { type: "button", className: "dsmc-confirm", disabled: busy, onClick: submit },
            busy ? "处理中…" : "开始压缩"
          )
        ),
        localError
          ? react.createElement("div", { className: "dsmc-msg dsmc-err" }, localError)
          : lastRun
            ? react.createElement(
              "div",
              { className: lastRun.ok ? "dsmc-msg" : "dsmc-msg dsmc-err" },
              lastRun.message + "（" + fmtTime(lastRun.at) + "）"
            )
            : null,
        react.createElement("hr", { className: "dsmc-sep" }),
        react.createElement("div", { className: "dsmc-title" }, "压缩存档（" + entries.length + "）"),
        entries.length === 0
          ? react.createElement("div", { className: "dsmc-empty" }, "暂无压缩记录。")
          : react.createElement(
            "div",
            { className: "dsmc-archive" },
            entries.map(function (n) {
              return react.createElement(
                "div",
                { key: String(n.seq) },
                react.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsmc-arch-item",
                    onClick: function () { setExpandedSeq(expandedSeq === n.seq ? null : n.seq); },
                  },
                  fmtTime(n.time) + " · " + (n.shadowedItemCount === null ? "?" : n.shadowedItemCount) + " 条 · ~" + fmtTokens(n.shadowedTokenCount) + " tokens"
                ),
                expandedSeq === n.seq && n.summary
                  ? react.createElement("div", { className: "dsmc-arch-summary" }, n.summary)
                  : null
              );
            })
          )
      );
    }

    /** Inline entry for the context meter popup (declared by patched DSH). */
    function MeterEntry(props) {
      return react.createElement(CompactControls, { scope: props.scope, session: props.session, sessionId: props.sessionId });
    }

    /** Composer-button entry with a floating popup, for stock DSH builds. */
    function RightEntry(props) {
      var scope = props.scope;
      var [open, setOpen] = useState(false);
      var rootRef = useRef(null);
      useEffect(function () {
        if (!open) return;
        function onPointerDown(e) {
          if (e.target instanceof Node && rootRef.current && rootRef.current.contains(e.target)) return;
          setOpen(false);
        }
        function onKeyDown(e) {
          if (e.key === "Escape") setOpen(false);
        }
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("pointerdown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);
      return react.createElement(
        "span",
        { ref: rootRef, className: "dsmc-wrap" },
        react.createElement(
          "button",
          {
            type: "button",
            className: "dsmc-btn",
            "aria-expanded": open,
            onClick: function () { setOpen(!open); },
          },
          "压缩"
        ),
        open
          ? react.createElement(
            "div",
            { className: "dsmc-pop", role: "dialog", "aria-label": "手动压缩上下文" },
            react.createElement(CompactControls, { scope: scope, session: props.session, sessionId: props.sessionId })
          )
          : null
      );
    }

    /**
     * Browser plugin body: bind the `manual-compact` settings scope, then
     * register the meter-panel section and — only when that slot is absent —
     * the composer button fallback.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: "manual-compact" });
      var meterDeclared = false;
      ctx.slots.inject("conversation.input.contextMeterPanel", function () {
        meterDeclared = true;
        return ctx.slots.register({
          name: "conversation.input.contextMeterPanel",
          id: "manual-compact",
          order: 0,
        }, function (props) {
          return react.createElement(MeterEntry, { scope: scope, session: props.session, sessionId: props.sessionId });
        });
      });
      ctx.timeout(function () {
        if (meterDeclared) return;
        ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register({
            name: "conversation.input.right",
            id: "manual-compact-button",
            order: 50,
          }, function (props) {
            return react.createElement(RightEntry, { scope: scope, session: props.session, sessionId: props.sessionId });
          });
        });
      }, 5000);
    }

    exports.name = "manual-compact-ui";
    exports.apply = apply;
    // Cordis service names the browser loader must wait for — NOT package
    // names (those belong in package.json's dsh.client.inject).
    exports.inject = [
      "slots",
      "settingsScope",
      "timer",
    ];
    return module.exports;
  },
});
