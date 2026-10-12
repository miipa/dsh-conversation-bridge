/**
 * @deepseek-ai/dsh-conversation-bridge/client — CLIENT half (prebuilt).
 *
 * A floating "Conversation Bridge" workspace opened from the per-session
 * conversation header. It is a ComfyUI-style two-pane editor:
 *
 *   - LEFT  : every session, grouped by workspace, each group collapsible and
 *             time-sorted (newest first). The list scrolls independently and its
 *             items are draggable onto the canvas.
 *   - RIGHT : a fixed, independently-pannable canvas. Drag a session from the
 *             left onto it to drop a NODE (sessionId + x/y). Drag from a node's
 *             output dot to another node to draw a DIRECTED edge (source ->
 *             target, with an arrow). Edges can be one-way or two-way, selected,
 *             and deleted.
 *
 * Crucially the canvas is the client's OWN view: node positions and directed
 * edges live in client state and persist to localStorage. Drawing a line does
 * NOT touch the host. Only when the user presses "Start" on a selected edge does
 * the client issue `/bridge connect` then `/bridge start --from <opener> ...`.
 *
 * The client is display + control only. It carries NO relay logic:
 *   - State IN  : bridge state is obtained by polling `/bridge status --json`
 *                 (the host keeps bridge state in memory only and no longer
 *                 writes a session projection). `projectionsBySession` is still
 *                 read, but ONLY for the `modelSelection` model name. A canvas
 *                 edge is highlighted "running" when a status row's pairId
 *                 matches the edge's pairId and its status === 'running'.
 *   - Control OUT: the stock `ctx.remote.commands.execute(sessionId, '/bridge ...', [])`
 *                 channel (the same RPC the composer uses for slash commands),
 *                 so a custom host->client remote namespace is never required.
 *
 * Shipped as the `window.__ModuleLoader__.load({ id, factory })` form the Web
 * client loader understands; the readable source is ../src/client.tsx.
 */
window.__ModuleLoader__.load({
  // Must equal the package name: dsh-client-modules registers the bundle under
  // its packageName and rejects any other id ("loaded without registering ...").
  id: "@local/dsh-conversation-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = require("react-dom");
    var h = React.createElement;
    var NS = "dsh-conversation-bridge";

    // localStorage keys. Canvas layout is versioned so a future schema change
    // can bump v1 -> v2 without colliding with stale data.
    var LS_CANVAS = "cbw:canvas:v1";
    var LS_COLLAPSE = "cbw:collapsed:"; // + workspaceId

    // ---- localized copy -----------------------------------------------------
    var en = {
      "panel.title": "Conversation Bridge",
      "panel.trigger": "Bridge",
      "panel.empty": "Open at least two sessions to bridge them.",
      "panel.hint": "Drag from one node's dot to another to create a bridge.",
      "panel.maxTurns": "Max turns",
      "panel.seed": "Seed (first message)",
      "panel.prefix": "Prefix peer label",
      "panel.start": "Start",
      "panel.stop": "Stop",
      "panel.delete": "Delete",
      "panel.running": "running",
      "panel.idle": "idle",
      "panel.close": "Close",
      "panel.connect": "Connect",
      "panel.connectHere": "Connect here",
      "panel.pickTarget": "Pick target… (click again to cancel)",
      "panel.picking": "Click another session to connect (click Connect to cancel)",
      "panel.ungrouped": "Ungrouped",
      "panel.firstSpeaker": "First speaker",
      "panel.oneway": "One-way",
      "panel.deleteEdge": "Delete",
      "panel.dragHint": "Drag a session onto the canvas to connect",
      "panel.collapse": "Collapse",
      "panel.expand": "Expand",
      "panel.source": "Source",
      "panel.target": "Target",
      "panel.applyTurns": "Apply turns",
    };
    var zh = {
      "panel.title": "对话桥",
      "panel.trigger": "对话桥",
      "panel.empty": "至少打开两个会话才能连线。",
      "panel.hint": "从一个节点的圆点拖到另一个节点即可建立对话桥。",
      "panel.maxTurns": "最大轮数",
      "panel.seed": "开场白（第一句）",
      "panel.prefix": "附加对端标记",
      "panel.start": "开始",
      "panel.stop": "停止",
      "panel.delete": "删除",
      "panel.running": "进行中",
      "panel.idle": "空闲",
      "panel.close": "关闭",
      "panel.connect": "连接",
      "panel.connectHere": "连到此",
      "panel.pickTarget": "选目标…（再点取消）",
      "panel.picking": "点击另一个会话完成连接（点“连接”可取消）",
      "panel.ungrouped": "未分组",
      "panel.firstSpeaker": "先发方",
      "panel.oneway": "单向",
      "panel.deleteEdge": "删除连线",
      "panel.dragHint": "把会话拖到右侧画布连线",
      "panel.collapse": "折叠",
      "panel.expand": "展开",
      "panel.source": "源",
      "panel.target": "目标",
      "panel.applyTurns": "应用轮次",
    };

    // ---- one-time stylesheet ------------------------------------------------
    var CSS =
      ".cbw-backdrop{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.28)}" +
      ".cbw-panel{position:fixed;z-index:201;top:50%;left:50%;transform:translate(-50%,-50%);" +
      "width:min(1040px,100vw - 32px);height:min(80vh,720px);display:flex;flex-direction:column;" +
      "background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);" +
      "border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:14px;" +
      "box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden;font-size:13px}" +
      ".cbw-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}" +
      ".cbw-title{font-weight:600;font-size:14px;flex:1}" +
      ".cbw-error{padding:6px 14px;color:#e5484d;font-size:12px;white-space:pre-wrap;word-break:break-word}" +
      ".cbw-body{display:flex;flex:1;min-height:0}" +
      // left column: grouped, collapsible, scrollable session list
      ".cbw-left{flex:none;width:248px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding:6px 0}" +
      ".cbw-grouphead{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;" +
      "font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);user-select:none;" +
      "position:sticky;top:0;background:var(--dsw-alias-bg-layer-1,#fff);z-index:1}" +
      ".cbw-grouphead:hover{color:var(--dsw-alias-label-primary,#111)}" +
      ".cbw-caret{display:inline-block;width:10px;transition:transform .12s ease}" +
      ".cbw-caret.col{transform:rotate(-90deg)}" +
      ".cbw-grouptitle{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".cbw-groupcount{opacity:.6;font-variant-numeric:tabular-nums}" +
      ".cbw-item{margin:2px 8px;padding:6px 8px;border-radius:8px;cursor:grab;" +
      "border:1px solid transparent;background:var(--dsw-alias-bg-layer-2,#f7f7f8)}" +
      ".cbw-item:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14))}" +
      ".cbw-item.on{opacity:.5}" +
      ".cbw-itemTitle{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".cbw-itemMeta{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".cbw-dotrun{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;background:#2fbf71}" +
      // right column: fixed canvas container (own scroll, independent of left)
      ".cbw-right{position:relative;flex:1;min-width:0;overflow:auto;background:" +
      "var(--dsw-alias-bg-layer-0,#fafafa);background-image:radial-gradient(var(--dsw-alias-border-l2,rgba(0,0,0,.07)) 1px,transparent 1px);background-size:22px 22px}" +
      ".cbw-canvas{position:relative;user-select:none;touch-action:none;min-width:100%;min-height:100%}" +
      ".cbw-cnode{position:absolute;box-sizing:border-box;width:180px;height:56px;padding:7px 9px;border-radius:10px;" +
      "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);" +
      "display:flex;flex-direction:column;justify-content:center;overflow:hidden;cursor:grab;" +
      "box-shadow:0 2px 6px rgba(0,0,0,.08)}" +
      ".cbw-cnode.drag{cursor:grabbing;box-shadow:0 8px 20px rgba(0,0,0,.22)}" +
      ".cbw-cnodeTitle{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".cbw-cnodeMeta{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".cbw-cstatus{position:absolute;left:7px;bottom:6px;width:8px;height:8px;border-radius:50%}" +
      ".cbw-run{background:#2fbf71}.cbw-stop{background:#b7bcc4}" +
      ".cbw-cdot{position:absolute;right:-8px;top:50%;transform:translateY(-50%);width:15px;height:15px;border-radius:50%;" +
      "background:#4f7cff;border:2px solid #fff;cursor:crosshair;box-shadow:0 1px 3px rgba(0,0,0,.3)}" +
      ".cbw-cin{position:absolute;left:-5px;top:50%;transform:translateY(-50%);width:9px;height:9px;border-radius:50%;" +
      "background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.18))}" +
      ".cbw-crm{position:absolute;right:4px;top:3px;width:16px;height:16px;line-height:14px;text-align:center;" +
      "border-radius:50%;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#888)}" +
      ".cbw-crm:hover{color:#e5484d;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}" +
      "@keyframes cbw-dash{to{stroke-dashoffset:-20}}" +
      ".cbw-edge-run{animation:cbw-dash .6s linear infinite}" +
      // floating edge-control box inside the right pane
      ".cbw-edgebox{position:absolute;right:12px;bottom:12px;z-index:5;width:260px;" +
      "background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));" +
      "border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.22);padding:10px 12px}" +
      ".cbw-canvashint{position:absolute;left:12px;top:12px;z-index:4;color:var(--dsw-alias-label-tertiary,#888);font-size:12px;pointer-events:none}" +
      ".cbw-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}" +
      ".cbw-field label{font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}" +
      ".cbw-field input[type=text],.cbw-field input[type=number],.cbw-field select{padding:6px 8px;border-radius:8px;" +
      "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:transparent;color:inherit;font:inherit}" +
      ".cbw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
      ".cbw-btn{padding:6px 12px;border-radius:8px;border:1px solid transparent;cursor:pointer;font:inherit}" +
      ".cbw-btn.primary{background:#4f7cff;color:#fff}.cbw-btn.stop{background:#e5484d;color:#fff}" +
      ".cbw-btn.ghost{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.15));color:inherit}" +
      ".cbw-badge{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}" +
      ".cbw-edgetitle{font-weight:600;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".cbw-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;background:0 0;border:0;" +
      "border-radius:6px;align-items:center;gap:5px;padding:3px 7px;font-size:12px;display:inline-flex}" +
      ".cbw-trigger:hover{color:var(--dsw-alias-label-primary,#111)}";
    (function injectCss() {
      var tagId = "@local/dsh-conversation-bridge/canvas.css";
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "@local/dsh-conversation-bridge";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    })();

    // ---- localStorage helpers (always guarded) ------------------------------
    function lsGet(key, fallback) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return fallback;
        var raw = window.localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }
    function lsSet(key, value) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* best-effort; private mode / quota errors must never break the UI */
      }
    }

    // ---- single-open coordination across header instances -------------------
    var openStore = (function () {
      var owner = null;
      var subs = new Set();
      return {
        get: function () { return owner; },
        set: function (id) { owner = id; subs.forEach(function (f) { f(); }); },
        sub: function (f) { subs.add(f); return function () { subs.delete(f); }; },
      };
    })();
    var instanceCounter = 0;

    // 桥接状态只能从宿主拿(宿主不再落盘投影),用一个模块级 store 缓存
    // `/bridge status --json` 的最新结果,所有组件订阅它。
    var bridgeStore = (function () {
      var rows = [];
      var lastSer = "[]";
      var subs = new Set();
      return {
        get: function () { return rows; },
        set: function (next) {
          var arr = Array.isArray(next) ? next : [];
          var ser = JSON.stringify(arr);
          if (ser === lastSer) return; // 内容未变:不换引用、不通知,避免每轮轮询触发重渲染
          lastSer = ser;
          rows = arr;
          subs.forEach(function (f) { f(); });
        },
        sub: function (f) { subs.add(f); return function () { subs.delete(f); }; },
      };
    })();

    // 单一共享轮询器:多个 header 组件 / 面板都 acquire 它,但始终只有一个
    // 定时器在跑(引用计数)。每轮用任意一个打开的会话 id 执行命令(status 是
    // 全局的,返回所有桥,与用哪个会话无关)。
    var bridgePoller = (function () {
      var refs = 0, timer = null, exec = null, getSid = null;
      function pollOnce() {
        if (typeof exec !== "function" || typeof getSid !== "function") return;
        var sid = getSid();
        if (!sid) return;
        var r;
        try { r = exec(sid, "/bridge status --json"); } catch (_) { return; }
        function handle(res) {
          var text = res && typeof res === "object" ? (res.kind === "error" ? null : res.text) : res;
          if (typeof text !== "string") return;
          try { var arr = JSON.parse(text); if (Array.isArray(arr)) bridgeStore.set(arr); } catch (_) { /* 忽略非 JSON */ }
        }
        if (r && typeof r.then === "function") r.then(handle).catch(function () {});
        else handle(r);
      }
      function anyRunning() {
        var rows = bridgeStore.get();
        for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].status === "running") return true;
        return false;
      }
      // 只有「面板打开(refs>0)且确有正在运行的桥」时才保留一个慢定时器;
      // 其余情况一律停表 —— 空闲 / 无运行桥时完全不轮询,因此不再有
      // `/bridge status` 的 command/run+command/done 日志刷屏。
      function sync() {
        if (refs > 0 && anyRunning()) {
          if (timer === null) timer = setInterval(pollOnce, 2500);
        } else if (timer !== null) {
          clearInterval(timer); timer = null;
        }
      }
      // 任何状态变化(含一次性 poll 的结果)后重新评估是否需要定时器。
      bridgeStore.sub(sync);
      return {
        poll: pollOnce,
        acquire: function (execFn, getSidFn) {
          exec = execFn; getSid = getSidFn; refs++;
          pollOnce(); // 打开面板时对账一次(一次性,不进入循环)
          sync();
          var released = false;
          return function () {
            if (released) return; released = true;
            refs--; if (refs < 0) refs = 0;
            sync();
          };
        },
      };
    })();

    // 由 status 行数组构造 pairId -> status 映射(替代旧的投影折叠逻辑)。
    function liveStatusFromRows(rows) {
      var out = {};
      (rows || []).forEach(function (r) { if (r && r.pairId) out[r.pairId] = r.status; });
      return out;
    }

    // ---- geometry -----------------------------------------------------------
    var NODE_W = 180, NODE_H = 56;
    function outPt(p) { return { x: p.x + NODE_W, y: p.y + NODE_H / 2 }; }
    function inPt(p) { return { x: p.x, y: p.y + NODE_H / 2 }; }
    function edgePath(x0, y0, x1, y1) {
      var mx = (x0 + x1) / 2;
      return "M" + x0 + "," + y0 + " C" + mx + "," + y0 + " " + mx + "," + y1 + " " + x1 + "," + y1;
    }

    // ---- derive per-session display info ------------------------------------
    function infoOf(byId, projById, id) {
      var s = (byId && byId[id]) || {};
      var vals = (projById && projById[id] && projById[id].values) || {};
      var model = vals.modelSelection && vals.modelSelection.next && vals.modelSelection.next.model;
      return {
        id: id,
        title: s.title || s.displayTitle || s.name || id.slice(0, 8),
        running: !!s.running,
        model: model || "",
      };
    }

    // Map pairId -> status, now driven by `/bridge status --json` rows via
    // liveStatusFromRows (see above); the old projection-folding helper is gone.

    // Group sessions by workspace (order = workspaces.items order), time-sorted
    // (updatedAt desc) within each group; sessions with no workspace go into a
    // trailing "ungrouped" bucket. Empty workspace groups are omitted.
    function buildGroups(byId, workspaces) {
      var items = (workspaces && workspaces.items) || [];
      var groups = items.map(function (w) {
        return { workspaceId: w.workspaceId, title: w.title, sessionIds: [], ungrouped: false };
      });
      var ofSession = {}; // sessionId -> group index
      items.forEach(function (w, gi) {
        (w.sessionIds || []).forEach(function (sid) { ofSession[sid] = gi; });
      });
      var ungrouped = [];
      Object.keys(byId || {}).forEach(function (id) {
        var gi = ofSession[id];
        if (gi === undefined || !groups[gi]) ungrouped.push(id);
        else groups[gi].sessionIds.push(id);
      });
      function upd(id) {
        var s = byId[id] || {};
        var n = Number(s.updatedAt);
        return isFinite(n) ? n : 0;
      }
      function desc(a, b) { return upd(b) - upd(a); }
      groups.forEach(function (g) { g.sessionIds.sort(desc); });
      ungrouped.sort(desc);
      var out = groups.filter(function (g) { return g.sessionIds.length > 0; });
      if (ungrouped.length > 0) {
        out.push({ workspaceId: "", title: null, sessionIds: ungrouped, ungrouped: true });
      }
      return out;
    }

    function groupKey(g) { return g.ungrouped ? "__ungrouped__" : (g.workspaceId || "__ws__"); }

    // ---- overlay (two-pane editor) ------------------------------------------
    function Overlay(props) {
      var t = props.t, execute = props.execute, onClose = props.onClose;
      var byId = props.byId, projById = props.projById, workspaces = props.workspaces;

      var groups = buildGroups(byId, workspaces);

      // 订阅桥接状态 store,并在面板打开期间驱动共享轮询器。
      var bridgeTick = React.useState(0);
      React.useEffect(function () {
        return bridgeStore.sub(function () { bridgeTick[1](function (n) { return n + 1; }); });
      }, []);
      React.useEffect(function () {
        return bridgePoller.acquire(execute, function () { return Object.keys(byId || {})[0]; });
      }, []);
      var bridgeRows = bridgeStore.get();
      var liveStatus = liveStatusFromRows(bridgeRows);
      // 某会话当前所属的桥(宿主每会话至多一桥)
      function bridgeRowOf(sid) {
        for (var i = 0; i < bridgeRows.length; i++) {
          var r = bridgeRows[i];
          if (r && (r.a === sid || r.b === sid)) return r;
        }
        return null;
      }
      // 某条边(pairId)对应的桥
      function bridgeRowForPair(pairId) {
        for (var i = 0; i < bridgeRows.length; i++) { if (bridgeRows[i] && bridgeRows[i].pairId === pairId) return bridgeRows[i]; }
        return null;
      }

      var rightRef = React.useRef(null);
      var canvasRef = React.useRef(null);

      // Canvas layout is the client's own persisted state.
      var canvasState = React.useState(function () {
        var init = lsGet(LS_CANVAS, null);
        if (!init || typeof init !== "object") return { nodes: [], edges: [] };
        return { nodes: Array.isArray(init.nodes) ? init.nodes : [], edges: Array.isArray(init.edges) ? init.edges : [] };
      });
      var canvas = canvasState[0], setCanvas = canvasState[1];
      React.useEffect(function () { lsSet(LS_CANVAS, canvas); }, [canvas]);

      var selState = React.useState(null);
      var selected = selState[0], setSelected = selState[1]; // edge pairId "from::to"
      var nodeDragState = React.useState(null);
      var nodeDrag = nodeDragState[0], setNodeDrag = nodeDragState[1]; // {id,ox,oy,x,y}
      var edgeDragState = React.useState(null);
      var edgeDrag = edgeDragState[0], setEdgeDrag = edgeDragState[1]; // {from,x,y}
      var errState = React.useState("");
      var connectError = errState[0], setConnectError = errState[1];

      // per-edge draft controls
      var mtState = React.useState("6"); var maxTurns = mtState[0], setMaxTurns = mtState[1];
      var seedState = React.useState(""); var seed = seedState[0], setSeed = seedState[1];
      var pfState = React.useState(false); var prefix = pfState[0], setPrefix = pfState[1];
      var fsState = React.useState("source"); var firstSpeaker = fsState[0], setFirstSpeaker = fsState[1];
      // When the selected edge changes, reset "first speaker" to the source and,
      // if that edge is already a live bridge, pull its REAL current maxTurns /
      // prefix into the drafts (read-only; this never calls execute).
      React.useEffect(function () {
        setFirstSpeaker("source");
        if (!selected) return;
        var b = bridgeRowForPair(selected);
        if (b) {
          if (Number.isFinite(b.maxTurns)) setMaxTurns(String(b.maxTurns));
          if (typeof b.prefix === "boolean") setPrefix(!!b.prefix);
        }
      }, [selected]);

      // collapse persistence: read/write per workspace key, forcing a re-render.
      var collapseTick = React.useState(0);
      function isCollapsed(key) { return lsGet(LS_COLLAPSE + key, false) === true; }
      function toggleCollapse(key) {
        lsSet(LS_COLLAPSE + key, !isCollapsed(key));
        collapseTick[1](function (n) { return n + 1; });
      }

      // ---- canvas model (filtered to currently-open sessions) ----
      var nodePos = {};
      canvas.nodes.forEach(function (nd) {
        if (nd && byId && byId[nd.id]) nodePos[nd.id] = { x: nd.x || 0, y: nd.y || 0 };
      });
      if (nodeDrag && nodePos[nodeDrag.id]) nodePos[nodeDrag.id] = { x: nodeDrag.x, y: nodeDrag.y };
      var renderNodes = Object.keys(nodePos).map(function (id) {
        return { id: id, x: nodePos[id].x, y: nodePos[id].y };
      });
      var renderEdges = canvas.edges.filter(function (e) {
        return e && nodePos[e.from] && nodePos[e.to];
      });

      // canvas bounds (so the right pane can scroll to reach distant nodes)
      var maxX = 760, maxY = 440;
      renderNodes.forEach(function (n) {
        if (n.x + NODE_W + 160 > maxX) maxX = n.x + NODE_W + 160;
        if (n.y + NODE_H + 160 > maxY) maxY = n.y + NODE_H + 160;
      });

      function canvasPoint(evt) {
        var r = canvasRef.current.getBoundingClientRect();
        return { x: evt.clientX - r.left, y: evt.clientY - r.top };
      }
      function nodeAt(x, y) {
        for (var i = renderNodes.length - 1; i >= 0; i--) {
          var n = renderNodes[i];
          if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n.id;
        }
        return null;
      }

      // ---- canvas mutations ----
      function addNode(sid, x, y) {
        var nx = Math.max(0, x - NODE_W / 2), ny = Math.max(0, y - NODE_H / 2);
        setCanvas(function (prev) {
          var exists = prev.nodes.some(function (n) { return n.id === sid; });
          if (exists) {
            // Same session only ever has one node: move the existing one.
            return {
              nodes: prev.nodes.map(function (n) { return n.id === sid ? { id: sid, x: nx, y: ny } : n; }),
              edges: prev.edges,
            };
          }
          return { nodes: prev.nodes.concat([{ id: sid, x: nx, y: ny }]), edges: prev.edges };
        });
      }
      function removeNode(sid) {
        setCanvas(function (prev) {
          return {
            nodes: prev.nodes.filter(function (n) { return n.id !== sid; }),
            edges: prev.edges.filter(function (e) { return e.from !== sid && e.to !== sid; }),
          };
        });
      }
      function addEdge(from, to) {
        if (!from || !to || from === to) return;
        setCanvas(function (prev) {
          if (prev.edges.some(function (e) { return e.from === from && e.to === to; })) return prev;
          return { nodes: prev.nodes, edges: prev.edges.concat([{ from: from, to: to, oneway: false }]) };
        });
        setSelected(from + "::" + to);
      }
      function setEdgeOneway(from, to, val) {
        setCanvas(function (prev) {
          return {
            nodes: prev.nodes,
            edges: prev.edges.map(function (e) {
              return e.from === from && e.to === to ? { from: e.from, to: e.to, oneway: val } : e;
            }),
          };
        });
      }

      // ---- host control (connect/start/stop/disconnect) ----
      // `execute` returns an unknown value — undefined, a thenable, or a command
      // result — so handle all shapes. `ignore` is a regex of host error texts
      // to swallow (e.g. "already bridged" when re-connecting a live edge).
      function runExec(sid, line, ignore, after) {
        var r;
        function fail(msg) {
          if (ignore && ignore.test(msg)) { if (after) after(); return; }
          setConnectError(msg);
        }
        try {
          r = execute(sid, line);
        } catch (e) {
          fail(String((e && e.message) || e));
          return;
        }
        if (r && typeof r.then === "function") {
          r.then(function (res) {
            if (res && res.kind === "error" && res.text) { fail(String(res.text)); return; }
            if (after) after();
          }).catch(function (e) {
            fail(String((e && e.message) || e));
          });
        } else if (after) {
          after();
        }
      }

      function doStart(edge, opener) {
        setConnectError("");
        var pairId = edge.from + "::" + edge.to;
        var connectLine = "/bridge connect " + edge.from + " " + edge.to + (edge.oneway ? " --oneway" : "");
        var startLine = "/bridge start " + pairId +
          " --from " + opener +
          " --max-turns " + (parseInt(maxTurns, 10) || 6);
        var s = (seed || "").replace(/"/g, "");
        if (s) startLine += ' --seed "' + s + '"';
        startLine += " --prefix " + (prefix ? "on" : "off");
        // Connect first; only once the (idle) bridge exists do we start it. An
        // "already bridged" connect is treated as success so re-starting works.
        runExec(edge.from, connectLine, /already bridged/i, function () {
          runExec(edge.from, startLine, null, function () {
            setTimeout(function () { bridgePoller.poll(); }, 120);
          });
        });
      }
      function doStop(edge) {
        setConnectError("");
        runExec(edge.from, "/bridge stop " + edge.from + "::" + edge.to, null, function () {
          setTimeout(function () { bridgePoller.poll(); }, 120);
        });
      }
      // Update an EXISTING bridge's turns/prefix WITHOUT sending any message.
      // `/bridge set` only mutates record fields on the host; no relay/start.
      function doSetTurns(edge) {
        setConnectError("");
        var pairId = edge.from + "::" + edge.to;
        runExec(
          edge.from,
          "/bridge set " + pairId +
            " --max-turns " + (parseInt(maxTurns, 10) || 6) +
            " --prefix " + (prefix ? "on" : "off"),
          null,
          function () {
            setTimeout(function () { bridgePoller.poll(); }, 120);
          }
        );
      }
      function doDelete(edge) {
        setConnectError("");
        // Tear down the host bridge if any (ignore "no bridge"), then drop the
        // edge from the client canvas regardless.
        runExec(edge.from, "/bridge disconnect " + edge.from + "::" + edge.to, /no bridge/i, function () {
          setTimeout(function () { bridgePoller.poll(); }, 120);
        });
        setCanvas(function (prev) {
          return {
            nodes: prev.nodes,
            edges: prev.edges.filter(function (e) { return !(e.from === edge.from && e.to === edge.to); }),
          };
        });
        setSelected(null);
        bridgePoller.poll();
      }

      // ---- pointer handlers (node move + edge draw) ----
      function onNodeDown(id, evt) {
        if (evt.button !== undefined && evt.button !== 0) return;
        evt.stopPropagation();
        var p = canvasPoint(evt);
        var pos = nodePos[id];
        setSelected(null);
        setNodeDrag({ id: id, ox: p.x - pos.x, oy: p.y - pos.y, x: pos.x, y: pos.y });
      }
      function onDotDown(id, evt) {
        evt.preventDefault();
        evt.stopPropagation();
        var p = canvasPoint(evt);
        setEdgeDrag({ from: id, x: p.x, y: p.y });
      }
      function onCanvasMove(evt) {
        if (nodeDrag) {
          var p = canvasPoint(evt);
          setNodeDrag({ id: nodeDrag.id, ox: nodeDrag.ox, oy: nodeDrag.oy,
            x: Math.max(0, p.x - nodeDrag.ox), y: Math.max(0, p.y - nodeDrag.oy) });
        } else if (edgeDrag) {
          var q = canvasPoint(evt);
          setEdgeDrag({ from: edgeDrag.from, x: q.x, y: q.y });
        }
      }
      function onCanvasUp(evt) {
        if (nodeDrag) {
          var nd = nodeDrag;
          setNodeDrag(null);
          setCanvas(function (prev) {
            return {
              nodes: prev.nodes.map(function (n) { return n.id === nd.id ? { id: n.id, x: nd.x, y: nd.y } : n; }),
              edges: prev.edges,
            };
          });
        } else if (edgeDrag) {
          var p = canvasPoint(evt);
          var target = nodeAt(p.x, p.y);
          var from = edgeDrag.from;
          setEdgeDrag(null);
          if (target && target !== from) addEdge(from, target);
        }
      }
      function onCanvasBgDown(evt) {
        // click on empty canvas clears selection
        if (evt.target === canvasRef.current) setSelected(null);
      }

      // ---- left column: grouped collapsible list ----
      var leftChildren = [];
      if (groups.length === 0) {
        leftChildren.push(h("div", { key: "__empty", className: "cbw-itemMeta", style: { padding: "8px 12px" } }, t("panel.empty")));
      }
      groups.forEach(function (g) {
        var key = groupKey(g);
        var collapsed = isCollapsed(key);
        var title = g.ungrouped ? t("panel.ungrouped") : (g.title || t("panel.ungrouped"));
        leftChildren.push(
          h("div", {
            key: "h:" + key,
            className: "cbw-grouphead",
            title: collapsed ? t("panel.expand") : t("panel.collapse"),
            onClick: function () { toggleCollapse(key); },
          },
            h("span", { className: "cbw-caret" + (collapsed ? " col" : "") }, "▾"),
            h("span", { className: "cbw-grouptitle" }, title),
            h("span", { className: "cbw-groupcount" }, String(g.sessionIds.length))
          )
        );
        if (collapsed) return;
        g.sessionIds.forEach(function (sid) {
          var info = infoOf(byId, projById, sid);
          var onCanvas = !!nodePos[sid];
          var b = bridgeRowOf(sid);
          var isRunning = b && b.pairId && liveStatus[b.pairId] === "running";
          leftChildren.push(
            h("div", {
              key: "s:" + sid,
              className: "cbw-item" + (onCanvas ? " on" : ""),
              draggable: true,
              title: sid,
              onDragStart: function (e) {
                try {
                  e.dataTransfer.setData("text/cb-session", sid);
                  e.dataTransfer.setData("text/plain", sid);
                  e.dataTransfer.effectAllowed = "copy";
                } catch (_) { /* ignore */ }
              },
            },
              h("div", { className: "cbw-itemTitle" },
                isRunning ? h("span", { className: "cbw-dotrun" }) : null,
                info.title),
              h("div", { className: "cbw-itemMeta" }, info.model || sid.slice(0, 12))
            )
          );
        });
      });
      var leftCol = h("div", { className: "cbw-left" }, leftChildren);

      // ---- right column: canvas ----
      // SVG edges + arrow markers + live drag preview
      var defs = h("defs", null,
        h("marker", { id: "cbw-ah", markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: "auto", markerUnits: "strokeWidth" },
          h("path", { d: "M0,0 L8,3 L0,6 Z", fill: "#9aa0ab" })),
        h("marker", { id: "cbw-ah-run", markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: "auto", markerUnits: "strokeWidth" },
          h("path", { d: "M0,0 L8,3 L0,6 Z", fill: "#2fbf71" })),
        h("marker", { id: "cbw-ah-sel", markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: "auto", markerUnits: "strokeWidth" },
          h("path", { d: "M0,0 L8,3 L0,6 Z", fill: "#4f7cff" }))
      );
      var paths = [];
      renderEdges.forEach(function (e) {
        var pairId = e.from + "::" + e.to;
        var o = outPt(nodePos[e.from]), i = inPt(nodePos[e.to]);
        var d = edgePath(o.x, o.y, i.x, i.y);
        var running = liveStatus[pairId] === "running";
        var isSel = pairId === selected;
        var stroke = isSel ? "#4f7cff" : running ? "#2fbf71" : "#9aa0ab";
        var marker = isSel ? "url(#cbw-ah-sel)" : running ? "url(#cbw-ah-run)" : "url(#cbw-ah)";
        // (a) fat invisible hit path: easy to click (~9px either side) and the
        //     only pointer target for the edge.
        paths.push(h("path", {
          key: pairId + "::hit",
          d: d,
          fill: "none",
          stroke: "transparent",
          strokeWidth: 18,
          style: { cursor: "pointer", pointerEvents: "stroke" },
          onClick: function (ev) { ev.stopPropagation(); setSelected(pairId); },
        }));
        // (b) visible path: styling/arrow/running only, never intercepts clicks.
        paths.push(h("path", {
          key: pairId,
          className: running ? "cbw-edge-run" : "",
          d: d,
          fill: "none",
          stroke: stroke,
          strokeWidth: isSel ? 3 : 2,
          strokeDasharray: running ? "6 4" : "0",
          markerEnd: marker,
          style: { pointerEvents: "none" },
        }));
      });
      if (edgeDrag && nodePos[edgeDrag.from]) {
        var od = outPt(nodePos[edgeDrag.from]);
        paths.push(h("path", {
          key: "__drag",
          d: edgePath(od.x, od.y, edgeDrag.x, edgeDrag.y),
          fill: "none", stroke: "#4f7cff", strokeWidth: 2, strokeDasharray: "4 4",
        }));
      }
      var svg = h("svg", {
        width: maxX, height: maxY,
        style: { position: "absolute", left: 0, top: 0, pointerEvents: "none" },
      }, defs, h("g", null, paths));

      var cnodes = renderNodes.map(function (n) {
        var info = infoOf(byId, projById, n.id);
        var dragging = nodeDrag && nodeDrag.id === n.id;
        return h("div", {
          key: n.id,
          className: "cbw-cnode" + (dragging ? " drag" : ""),
          style: { left: n.x, top: n.y },
          onPointerDown: function (e) { onNodeDown(n.id, e); },
        },
          h("span", {
            className: "cbw-crm", title: t("panel.delete"),
            onPointerDown: function (e) { e.stopPropagation(); e.preventDefault(); },
            onClick: function (e) { e.stopPropagation(); removeNode(n.id); },
          }, "×"),
          h("div", { className: "cbw-cnodeTitle" }, info.title),
          h("div", { className: "cbw-cnodeMeta" }, info.model || n.id.slice(0, 12)),
          h("span", { className: "cbw-cstatus " + (info.running ? "cbw-run" : "cbw-stop") }),
          h("span", { className: "cbw-cin" }),
          h("span", { className: "cbw-cdot", title: t("panel.hint"),
            onPointerDown: function (e) { onDotDown(n.id, e); } })
        );
      });

      var canvasInner = h("div", {
        className: "cbw-canvas",
        ref: canvasRef,
        style: { width: maxX, height: maxY },
        onPointerMove: onCanvasMove,
        onPointerUp: onCanvasUp,
        onPointerLeave: function () { setNodeDrag(null); setEdgeDrag(null); },
        onPointerDown: onCanvasBgDown,
      }, svg, cnodes);

      // selected edge control box
      var selEdge = null;
      for (var k = 0; k < renderEdges.length; k++) {
        if (renderEdges[k].from + "::" + renderEdges[k].to === selected) selEdge = renderEdges[k];
      }
      var edgeBox = null;
      if (selEdge) {
        var pairId = selEdge.from + "::" + selEdge.to;
        var running = liveStatus[pairId] === "running";
        // "connected" = 该边存在一个活着的宿主桥(idle 或 running),从 status 行判断。
        var edgeConnected = !!bridgeRowForPair(pairId);
        var fromInfo = infoOf(byId, projById, selEdge.from);
        var toInfo = infoOf(byId, projById, selEdge.to);
        var opener = firstSpeaker === "target" ? selEdge.to : selEdge.from;
        edgeBox = h("div", { className: "cbw-edgebox", onPointerDown: function (e) { e.stopPropagation(); } },
          h("div", { className: "cbw-edgetitle" }, fromInfo.title + "  →  " + toInfo.title),
          h("div", { className: "cbw-row", style: { marginBottom: "8px" } },
            h("label", { className: "cbw-badge" },
              h("input", {
                type: "checkbox", checked: !!selEdge.oneway,
                onChange: function (e) { setEdgeOneway(selEdge.from, selEdge.to, e.target.checked); },
                style: { marginRight: "6px" },
              }),
              t("panel.oneway")
            )
          ),
          h("div", { className: "cbw-field" },
            h("label", null, t("panel.firstSpeaker")),
            h("select", { value: firstSpeaker, onChange: function (e) { setFirstSpeaker(e.target.value); } },
              h("option", { value: "source" }, t("panel.source") + " · " + fromInfo.title),
              h("option", { value: "target" }, t("panel.target") + " · " + toInfo.title)
            )
          ),
          h("div", { className: "cbw-field" },
            h("label", null, t("panel.maxTurns")),
            h("input", { type: "number", min: 1, value: maxTurns,
              onChange: function (e) { setMaxTurns(e.target.value); } })
          ),
          h("div", { className: "cbw-field" },
            h("label", null, t("panel.seed")),
            h("input", { type: "text", value: seed, placeholder: "我们来辩论：Vim vs Emacs",
              onChange: function (e) { setSeed(e.target.value); } })
          ),
          h("div", { className: "cbw-row", style: { marginBottom: "8px" } },
            h("label", { className: "cbw-badge" },
              h("input", { type: "checkbox", checked: prefix,
                onChange: function (e) { setPrefix(e.target.checked); }, style: { marginRight: "6px" } }),
              t("panel.prefix")
            )
          ),
          h("div", { className: "cbw-row" },
            running
              ? h("button", { className: "cbw-btn stop", onClick: function () { doStop(selEdge); } }, t("panel.stop"))
              : h("button", { className: "cbw-btn primary", onClick: function () { doStart(selEdge, opener); } }, t("panel.start")),
            edgeConnected
              ? h("button", { className: "cbw-btn ghost", onClick: function () { doSetTurns(selEdge); } }, t("panel.applyTurns"))
              : null,
            h("button", { className: "cbw-btn ghost", onClick: function () { doDelete(selEdge); } }, t("panel.deleteEdge")),
            h("span", { className: "cbw-badge" },
              (running ? t("panel.running") : t("panel.idle")))
          )
        );
      }

      var hint = renderNodes.length === 0
        ? h("div", { className: "cbw-canvashint" }, t("panel.dragHint"))
        : null;

      var rightCol = h("div", {
        className: "cbw-right",
        ref: rightRef,
        onDragOver: function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = "copy"; } catch (_) {} },
        onDrop: function (e) {
          e.preventDefault();
          var sid = "";
          try { sid = e.dataTransfer.getData("text/cb-session") || e.dataTransfer.getData("text/plain"); } catch (_) {}
          if (!sid || !byId || !byId[sid]) return;
          var r = canvasRef.current.getBoundingClientRect();
          addNode(sid, e.clientX - r.left, e.clientY - r.top);
        },
      }, canvasInner, hint, edgeBox);

      var panel = h("div", { className: "cbw-panel", onClick: function (e) { e.stopPropagation(); } },
        h("div", { className: "cbw-head" },
          h("span", { className: "cbw-title" }, t("panel.title")),
          h("button", { className: "cbw-btn ghost", onClick: onClose }, t("panel.close"))
        ),
        connectError ? h("div", { className: "cbw-error" }, connectError) : null,
        h("div", { className: "cbw-body" }, leftCol, rightCol)
      );

      return h("div", { className: "cbw-backdrop", onClick: onClose }, panel);
    }

    // ---- slot component (per session header) --------------------------------
    function BridgeAction(props) {
      var useSessions = props.useSessions;
      var useWorkspaces = props.useWorkspaces;
      var execute = props.execute;
      var t = props.t;

      var idRef = React.useRef(null);
      if (idRef.current === null) idRef.current = "cb-" + ++instanceCounter;
      var myId = idRef.current;

      // subscribe to the single-open store
      var tick = React.useState(0);
      React.useEffect(function () {
        return openStore.sub(function () { tick[1](function (n) { return n + 1; }); });
      }, []);
      var isOpen = openStore.get() === myId;

      // live session + projection + workspace snapshots
      var byId = useSessions(function (s) { return s.byId; });
      var projById = useSessions(function (s) { return s.projectionsBySession; });
      // useWorkspaces is provided to slot components the same way useSessions is;
      // guard anyway so a headless/absent store degrades to "all ungrouped".
      var workspaces = typeof useWorkspaces === "function"
        ? useWorkspaces(function (s) { return s; })
        : { items: [], phase: "ready" };

      // 徽标只订阅 store 以重渲染,不再自己驱动轮询器:桥接状态只在本会话内
      // 由画布面板的操作/轮询产生,应用重启后宿主内存清空即为 0,读 store 即可。
      var bridgeTick = React.useState(0);
      React.useEffect(function () {
        return bridgeStore.sub(function () { bridgeTick[1](function (n) { return n + 1; }); });
      }, []);
      // 徽标:当前处于 running 的不同桥的数量
      var runningSet = {};
      bridgeStore.get().forEach(function (r) { if (r && r.pairId && r.status === "running") runningSet[r.pairId] = true; });
      var runningCount = Object.keys(runningSet).length;

      var trigger = h("button", {
        className: "cbw-trigger",
        onClick: function () { openStore.set(isOpen ? null : myId); },
        title: t("panel.title"),
      },
        "🔗 ", t("panel.trigger"),
        runningCount > 0 ? h("span", { className: "cbw-badge" }, " " + runningCount) : null
      );

      var overlay = isOpen
        ? ReactDOM.createPortal(
            h(Overlay, {
              t: t,
              execute: execute,
              byId: byId,
              projById: projById,
              workspaces: workspaces,
              onClose: function () { openStore.set(null); },
            }),
            document.body
          )
        : null;

      return h(React.Fragment, null, trigger, overlay);
    }

    // ---- plugin entry -------------------------------------------------------
    // Cordis' inject guard validates each property hop: accessing ctx.remote
    // needs "remote", and accessing .commands on it needs "remote.commands" —
    // so BOTH tokens must be listed. Otherwise the access throws
    // 'cannot get property "remote[.commands]" without inject'. The call site
    // below uses ctx.remote.commands.execute(...).
    var inject = ["slots", "locale", "remote", "remote.commands"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-conversation-bridge: dictionaries");

      // Business share handed to the slot component: a thin wrapper over the
      // stock Commands RPC. All relay logic stays on the host.
      var actions = {
        execute: function (sessionId, line) {
          return ctx.remote.commands.execute(sessionId, line, []);
        },
      };

      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "dsh-conversation-bridge",
            order: -15,
            locale: NS,
            inject: function () { return actions; },
          },
          BridgeAction
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
