/**
 * @deepseek-ai/dsh-conversation-bridge/client — CLIENT half (authoritative TSX source).
 *
 * Compiles + wraps into ../lib/client.js (the `window.__ModuleLoader__.load`
 * artifact the Web client loader understands). Keep behaviour in sync.
 *
 * The browser build tooling isn't available in this environment, so the shipped
 * ../lib/client.js is hand-authored in the ModuleLoader form rather than emitted
 * from this file. This source documents the same component tree in idiomatic
 * React/TSX for review and future rebuilds.
 *
 * A ComfyUI-style two-pane editor:
 *   - LEFT  : every session, grouped by workspace (group order = workspaces.items
 *             order), each group collapsible with its state persisted to
 *             localStorage, each group time-sorted (updatedAt desc). The list
 *             scrolls independently; items are draggable onto the canvas.
 *   - RIGHT : a fixed, independently-pannable canvas. Dropping a session places a
 *             NODE (sessionId + x/y); dragging a node's output dot to another
 *             node draws a DIRECTED edge (source -> target). Edges can be one-way
 *             or two-way, selected, and deleted. Node positions and edges are the
 *             client's OWN state, persisted to localStorage ("cbw:canvas:v1").
 *
 * Drawing a line never touches the host. Only "Start" on a selected edge issues
 * `/bridge connect` then `/bridge start --from <opener> ...`.
 *
 * Display + control only — no relay logic lives here:
 *   - reads host state by polling `/bridge status --json` (the host keeps bridge
 *     state in memory only and no longer writes a session projection);
 *     `projectionsBySession` is still read, but ONLY for the modelSelection model name
 *   - sends control via the stock `ctx.remote.commands.execute(id, '/bridge ...', [])`
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'

/**
 * Client capability names made available on `ctx` for this plugin. Cordis'
 * inject guard validates each property hop: accessing ctx.remote needs
 * "remote", and accessing .commands on it needs "remote.commands" — so BOTH
 * tokens must be listed. The control call uses ctx.remote.commands.execute(...).
 */
export const inject = ['slots', 'locale', 'remote', 'remote.commands']

const NS = 'dsh-conversation-bridge'
const LS_CANVAS = 'cbw:canvas:v1'
const LS_COLLAPSE = 'cbw:collapsed:' // + workspaceId

// ---- store-shaped props the slot framework injects -------------------------
type Selector<T> = <R>(sel: (state: T) => R) => R
interface SessionSummary {
  title?: string
  displayTitle?: string
  name?: string
  running?: boolean
  updatedAt?: number
  cwd?: string
}
interface SessionsState {
  byId: Record<string, SessionSummary>
  projectionsBySession: Record<string, { values: Record<string, unknown> }>
  phase: string
}
interface WorkspaceItem {
  workspaceId: string
  title?: string
  sessionIds: string[]
}
interface WorkspacesState {
  items: WorkspaceItem[]
  phase: string
}
interface ActionProps {
  sessionId: string
  useSessions: Selector<SessionsState>
  useWorkspaces?: Selector<WorkspacesState>
  execute: (sessionId: string, line: string) => Promise<unknown>
  t: (key: string, vars?: Record<string, unknown>) => string
}

interface BridgeRow {
  pairId: string
  a: string
  b: string
  status: 'idle' | 'running'
  turn: number
  maxTurns: number
  prefix?: boolean
  lastFrom: string | null
  mode?: 'both' | 'oneway'
}
interface NodeInfo {
  id: string
  title: string
  running: boolean
  model: string
}
/** Persisted canvas layout: client-owned node positions + directed edges. */
interface CanvasNode {
  id: string
  x: number
  y: number
}
interface CanvasEdge {
  from: string
  to: string
  oneway: boolean
}
interface CanvasState {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}
interface Group {
  workspaceId: string
  title: string | null
  sessionIds: string[]
  ungrouped: boolean
}

// ---- geometry --------------------------------------------------------------
const NODE_W = 180
const NODE_H = 56
const outPt = (p: { x: number; y: number }) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 })
const inPt = (p: { x: number; y: number }) => ({ x: p.x, y: p.y + NODE_H / 2 })
const edgePath = (x0: number, y0: number, x1: number, y1: number) => {
  const mx = (x0 + x1) / 2
  return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`
}

// ---- localStorage helpers (always guarded) ---------------------------------
function lsGet<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback
    const raw = window.localStorage.getItem(key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function lsSet(key: string, value: unknown): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* best-effort */
  }
}

function infoOf(state: SessionsState, id: string): NodeInfo {
  const s = state.byId[id] || {}
  const values = (state.projectionsBySession[id]?.values ?? {}) as Record<string, any>
  return {
    id,
    title: s.title || s.displayTitle || s.name || id.slice(0, 8),
    running: !!s.running,
    model: values.modelSelection?.next?.model || '',
  }
}

/** Build a pairId -> status map from `/bridge status --json` rows (replaces the
 *  old projection-folding helper). */
function liveStatusFromRows(rows: BridgeRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows || []) if (r && r.pairId) out[r.pairId] = r.status
  return out
}

// Group sessions by workspace (order = workspaces.items order), time-sorted
// (updatedAt desc) within each group; unassigned sessions go into a trailing
// "ungrouped" bucket. Empty workspace groups are omitted.
function buildGroups(state: SessionsState, workspaces: WorkspacesState): Group[] {
  const items = workspaces.items || []
  const groups: Group[] = items.map((w) => ({ workspaceId: w.workspaceId, title: w.title ?? null, sessionIds: [], ungrouped: false }))
  const ofSession: Record<string, number> = {}
  items.forEach((w, gi) => (w.sessionIds || []).forEach((sid) => (ofSession[sid] = gi)))
  const ungrouped: string[] = []
  for (const id of Object.keys(state.byId)) {
    const gi = ofSession[id]
    if (gi === undefined || !groups[gi]) ungrouped.push(id)
    else groups[gi].sessionIds.push(id)
  }
  const upd = (id: string) => {
    const n = Number(state.byId[id]?.updatedAt)
    return isFinite(n) ? n : 0
  }
  const desc = (a: string, b: string) => upd(b) - upd(a)
  groups.forEach((g) => g.sessionIds.sort(desc))
  ungrouped.sort(desc)
  const out = groups.filter((g) => g.sessionIds.length > 0)
  if (ungrouped.length > 0) out.push({ workspaceId: '', title: null, sessionIds: ungrouped, ungrouped: true })
  return out
}

const groupKey = (g: Group) => (g.ungrouped ? '__ungrouped__' : g.workspaceId || '__ws__')

// ---- single-open coordination across header instances ----------------------
const openStore = (() => {
  let owner: string | null = null
  const subs = new Set<() => void>()
  return {
    get: () => owner,
    set: (id: string | null) => {
      owner = id
      subs.forEach((f) => f())
    },
    sub: (f: () => void) => {
      subs.add(f)
      return () => subs.delete(f)
    },
  }
})()
let instanceCounter = 0

// Bridge state can only come from the host (which no longer persists a
// projection). A module-level store caches the latest `/bridge status --json`
// rows; every component subscribes to it.
const bridgeStore = (() => {
  let rows: BridgeRow[] = []
  let lastSer = '[]'
  const subs = new Set<() => void>()
  return {
    get: () => rows,
    set: (next: unknown) => {
      const arr = Array.isArray(next) ? (next as BridgeRow[]) : []
      const ser = JSON.stringify(arr)
      if (ser === lastSer) return // 内容未变:不换引用、不通知,避免每轮轮询触发重渲染
      lastSer = ser
      rows = arr
      subs.forEach((f) => f())
    },
    sub: (f: () => void) => {
      subs.add(f)
      return () => subs.delete(f)
    },
  }
})()

// A single shared poller: multiple header components / panels acquire it, but
// only ever one timer runs (reference-counted). Each tick runs the command with
// any open session id (status is global and returns all bridges regardless of
// which session is used).
const bridgePoller = (() => {
  let refs = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let exec: ((sid: string, line: string) => unknown) | null = null
  let getSid: (() => string | undefined) | null = null
  const pollOnce = () => {
    if (typeof exec !== 'function' || typeof getSid !== 'function') return
    const sid = getSid()
    if (!sid) return
    let r: unknown
    try {
      r = exec(sid, '/bridge status --json')
    } catch {
      return
    }
    const handle = (res: any) => {
      const text = res && typeof res === 'object' ? (res.kind === 'error' ? null : res.text) : res
      if (typeof text !== 'string') return
      try {
        const arr = JSON.parse(text)
        if (Array.isArray(arr)) bridgeStore.set(arr)
      } catch {
        /* 忽略非 JSON */
      }
    }
    const thenable = r as { then?: Function; catch?: Function } | undefined
    if (thenable && typeof thenable.then === 'function') Promise.resolve(r as Promise<any>).then(handle).catch(() => {})
    else handle(r)
  }
  const anyRunning = () => {
    const rows = bridgeStore.get()
    for (const r of rows) if (r && r.status === 'running') return true
    return false
  }
  // Keep a single slow timer only while the panel is open (refs>0) AND a bridge
  // is actually running; otherwise stop the clock. Idle / no-running-bridge
  // states never poll, so there is no more `/bridge status` command/run+done
  // log spam.
  const sync = () => {
    if (refs > 0 && anyRunning()) {
      if (timer === null) timer = setInterval(pollOnce, 2500)
    } else if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  // Re-evaluate whether a timer is needed after any state change (incl. a
  // one-shot poll's result).
  bridgeStore.sub(sync)
  return {
    poll: pollOnce,
    acquire: (execFn: (sid: string, line: string) => unknown, getSidFn: () => string | undefined) => {
      exec = execFn
      getSid = getSidFn
      refs++
      pollOnce() // reconcile once when the panel opens (one-shot, not a loop)
      sync()
      let released = false
      return () => {
        if (released) return
        released = true
        refs--
        if (refs < 0) refs = 0
        sync()
      }
    },
  }
})()

// ---- overlay (two-pane editor) ---------------------------------------------
function Overlay(props: {
  t: ActionProps['t']
  execute: ActionProps['execute']
  state: SessionsState
  workspaces: WorkspacesState
  onClose: () => void
}) {
  const { t, execute, state, workspaces, onClose } = props
  const groups = buildGroups(state, workspaces)

  // Subscribe to the bridge-state store and drive the shared poller while open.
  const [, bumpBridge] = React.useState(0)
  React.useEffect(() => bridgeStore.sub(() => bumpBridge((n) => n + 1)), [])
  React.useEffect(() => bridgePoller.acquire(execute, () => Object.keys(state.byId || {})[0]), [])
  const bridgeRows = bridgeStore.get()
  const liveStatus = liveStatusFromRows(bridgeRows)
  // The bridge a session currently belongs to (host allows at most one per session).
  const bridgeRowOf = (sid: string): BridgeRow | null => {
    for (const r of bridgeRows) if (r && (r.a === sid || r.b === sid)) return r
    return null
  }
  // The bridge for a given edge (pairId).
  const bridgeRowForPair = (pairId: string): BridgeRow | null => {
    for (const r of bridgeRows) if (r && r.pairId === pairId) return r
    return null
  }

  const canvasRef = React.useRef<HTMLDivElement>(null)

  const [canvas, setCanvas] = React.useState<CanvasState>(() => {
    const init = lsGet<CanvasState | null>(LS_CANVAS, null)
    if (!init || typeof init !== 'object') return { nodes: [], edges: [] }
    return { nodes: Array.isArray(init.nodes) ? init.nodes : [], edges: Array.isArray(init.edges) ? init.edges : [] }
  })
  React.useEffect(() => lsSet(LS_CANVAS, canvas), [canvas])

  const [selected, setSelected] = React.useState<string | null>(null) // edge pairId "from::to"
  const [nodeDrag, setNodeDrag] = React.useState<{ id: string; ox: number; oy: number; x: number; y: number } | null>(null)
  const [edgeDrag, setEdgeDrag] = React.useState<{ from: string; x: number; y: number } | null>(null)
  const [connectError, setConnectError] = React.useState('')
  const [maxTurns, setMaxTurns] = React.useState('6')
  const [seed, setSeed] = React.useState('')
  const [prefix, setPrefix] = React.useState(false)
  const [firstSpeaker, setFirstSpeaker] = React.useState<'source' | 'target'>('source')
  // On edge-selection change: reset first speaker, and if the edge is already a
  // live bridge, pull its REAL current maxTurns/prefix into the drafts. Draft
  // only — this never calls execute.
  React.useEffect(() => {
    setFirstSpeaker('source')
    if (!selected) return
    const b = bridgeRowForPair(selected)
    if (b) {
      if (Number.isFinite(b.maxTurns)) setMaxTurns(String(b.maxTurns))
      if (typeof b.prefix === 'boolean') setPrefix(!!b.prefix)
    }
  }, [selected])

  // collapse state persists per workspace key; a tick forces a re-render.
  const [, bumpCollapse] = React.useState(0)
  const isCollapsed = (key: string) => lsGet<boolean>(LS_COLLAPSE + key, false) === true
  const toggleCollapse = (key: string) => {
    lsSet(LS_COLLAPSE + key, !isCollapsed(key))
    bumpCollapse((n) => n + 1)
  }

  // canvas model (filtered to currently-open sessions)
  const nodePos: Record<string, { x: number; y: number }> = {}
  canvas.nodes.forEach((nd) => {
    if (nd && state.byId[nd.id]) nodePos[nd.id] = { x: nd.x || 0, y: nd.y || 0 }
  })
  if (nodeDrag && nodePos[nodeDrag.id]) nodePos[nodeDrag.id] = { x: nodeDrag.x, y: nodeDrag.y }
  const renderNodes = Object.keys(nodePos).map((id) => ({ id, x: nodePos[id].x, y: nodePos[id].y }))
  const renderEdges = canvas.edges.filter((e) => e && nodePos[e.from] && nodePos[e.to])

  let maxX = 760
  let maxY = 440
  renderNodes.forEach((n) => {
    if (n.x + NODE_W + 160 > maxX) maxX = n.x + NODE_W + 160
    if (n.y + NODE_H + 160 > maxY) maxY = n.y + NODE_H + 160
  })

  const canvasPoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const nodeAt = (x: number, y: number): string | null => {
    for (let i = renderNodes.length - 1; i >= 0; i--) {
      const n = renderNodes[i]
      if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n.id
    }
    return null
  }

  // ---- canvas mutations ----
  const addNode = (sid: string, x: number, y: number) => {
    const nx = Math.max(0, x - NODE_W / 2)
    const ny = Math.max(0, y - NODE_H / 2)
    setCanvas((prev) => {
      if (prev.nodes.some((n) => n.id === sid)) {
        // one node per session: move the existing one
        return { nodes: prev.nodes.map((n) => (n.id === sid ? { id: sid, x: nx, y: ny } : n)), edges: prev.edges }
      }
      return { nodes: prev.nodes.concat([{ id: sid, x: nx, y: ny }]), edges: prev.edges }
    })
  }
  const removeNode = (sid: string) =>
    setCanvas((prev) => ({
      nodes: prev.nodes.filter((n) => n.id !== sid),
      edges: prev.edges.filter((e) => e.from !== sid && e.to !== sid),
    }))
  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return
    setCanvas((prev) =>
      prev.edges.some((e) => e.from === from && e.to === to)
        ? prev
        : { nodes: prev.nodes, edges: prev.edges.concat([{ from, to, oneway: false }]) },
    )
    setSelected(`${from}::${to}`)
  }
  const setEdgeOneway = (from: string, to: string, val: boolean) =>
    setCanvas((prev) => ({
      nodes: prev.nodes,
      edges: prev.edges.map((e) => (e.from === from && e.to === to ? { from: e.from, to: e.to, oneway: val } : e)),
    }))

  // ---- host control: `execute` returns undefined | thenable | {kind,text}.
  // `ignore` swallows benign host errors (e.g. "already bridged" on re-connect).
  const runExec = (sid: string, line: string, ignore: RegExp | null, after: (() => void) | null) => {
    const fail = (msg: string) => {
      if (ignore && ignore.test(msg)) {
        if (after) after()
        return
      }
      setConnectError(msg)
    }
    let r: unknown
    try {
      r = execute(sid, line)
    } catch (e: any) {
      fail(String((e && e.message) || e))
      return
    }
    const thenable = r as { then?: Function } | undefined
    if (thenable && typeof thenable.then === 'function') {
      Promise.resolve(r as Promise<any>)
        .then((res: any) => {
          if (res && res.kind === 'error' && res.text) {
            fail(String(res.text))
            return
          }
          if (after) after()
        })
        .catch((e: any) => fail(String((e && e.message) || e)))
    } else if (after) {
      after()
    }
  }

  const doStart = (edge: CanvasEdge, opener: string) => {
    setConnectError('')
    const pairId = `${edge.from}::${edge.to}`
    const connectLine = `/bridge connect ${edge.from} ${edge.to}${edge.oneway ? ' --oneway' : ''}`
    let startLine = `/bridge start ${pairId} --from ${opener} --max-turns ${parseInt(maxTurns, 10) || 6}`
    const s = (seed || '').replace(/"/g, '')
    if (s) startLine += ` --seed "${s}"`
    startLine += ` --prefix ${prefix ? 'on' : 'off'}`
    // Connect first; start only after the idle bridge exists. "already bridged"
    // is treated as success so re-starting a drawn edge works.
    runExec(edge.from, connectLine, /already bridged/i, () =>
      runExec(edge.from, startLine, null, () => {
        setTimeout(() => bridgePoller.poll(), 120)
      }),
    )
  }
  const doStop = (edge: CanvasEdge) => {
    setConnectError('')
    runExec(edge.from, `/bridge stop ${edge.from}::${edge.to}`, null, () => {
      setTimeout(() => bridgePoller.poll(), 120)
    })
  }
  // Update an existing bridge's turns/prefix WITHOUT sending any message.
  const doSetTurns = (edge: CanvasEdge) => {
    setConnectError('')
    const pairId = `${edge.from}::${edge.to}`
    runExec(
      edge.from,
      `/bridge set ${pairId} --max-turns ${parseInt(maxTurns, 10) || 6} --prefix ${prefix ? 'on' : 'off'}`,
      null,
      () => {
        setTimeout(() => bridgePoller.poll(), 120)
      },
    )
  }
  const doDelete = (edge: CanvasEdge) => {
    setConnectError('')
    runExec(edge.from, `/bridge disconnect ${edge.from}::${edge.to}`, /no bridge/i, () => {
      setTimeout(() => bridgePoller.poll(), 120)
    })
    setCanvas((prev) => ({
      nodes: prev.nodes,
      edges: prev.edges.filter((e) => !(e.from === edge.from && e.to === edge.to)),
    }))
    setSelected(null)
    bridgePoller.poll()
  }

  // ---- pointer handlers ----
  const onNodeDown = (id: string, e: React.PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return
    e.stopPropagation()
    const p = canvasPoint(e)
    const pos = nodePos[id]
    setSelected(null)
    setNodeDrag({ id, ox: p.x - pos.x, oy: p.y - pos.y, x: pos.x, y: pos.y })
  }
  const onDotDown = (id: string, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const p = canvasPoint(e)
    setEdgeDrag({ from: id, x: p.x, y: p.y })
  }
  const onCanvasMove = (e: React.PointerEvent) => {
    if (nodeDrag) {
      const p = canvasPoint(e)
      setNodeDrag({ id: nodeDrag.id, ox: nodeDrag.ox, oy: nodeDrag.oy, x: Math.max(0, p.x - nodeDrag.ox), y: Math.max(0, p.y - nodeDrag.oy) })
    } else if (edgeDrag) {
      const q = canvasPoint(e)
      setEdgeDrag({ from: edgeDrag.from, x: q.x, y: q.y })
    }
  }
  const onCanvasUp = (e: React.PointerEvent) => {
    if (nodeDrag) {
      const nd = nodeDrag
      setNodeDrag(null)
      setCanvas((prev) => ({ nodes: prev.nodes.map((n) => (n.id === nd.id ? { id: n.id, x: nd.x, y: nd.y } : n)), edges: prev.edges }))
    } else if (edgeDrag) {
      const p = canvasPoint(e)
      const target = nodeAt(p.x, p.y)
      const from = edgeDrag.from
      setEdgeDrag(null)
      if (target && target !== from) addEdge(from, target)
    }
  }

  const selEdge = renderEdges.find((e) => `${e.from}::${e.to}` === selected) ?? null
  const selFrom = selEdge ? infoOf(state, selEdge.from) : null
  const selTo = selEdge ? infoOf(state, selEdge.to) : null
  const selPairId = selEdge ? `${selEdge.from}::${selEdge.to}` : ''
  const selRunning = selEdge ? liveStatus[selPairId] === 'running' : false
  const opener = selEdge ? (firstSpeaker === 'target' ? selEdge.to : selEdge.from) : ''
  // "connected" = a live host bridge (idle or running) exists for the selected edge.
  const edgeConnected = selEdge ? !!bridgeRowForPair(selPairId) : false

  return (
    <div className="cbw-backdrop" onClick={onClose}>
      <div className="cbw-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cbw-head">
          <span className="cbw-title">{t('panel.title')}</span>
          <button className="cbw-btn ghost" onClick={onClose}>{t('panel.close')}</button>
        </div>
        {connectError ? <div className="cbw-error">{connectError}</div> : null}
        <div className="cbw-body">
          {/* LEFT: grouped, collapsible, time-sorted, scrollable, draggable */}
          <div className="cbw-left">
            {groups.length === 0 ? <div className="cbw-itemMeta" style={{ padding: '8px 12px' }}>{t('panel.empty')}</div> : null}
            {groups.map((g) => {
              const key = groupKey(g)
              const collapsed = isCollapsed(key)
              const title = g.ungrouped ? t('panel.ungrouped') : g.title || t('panel.ungrouped')
              return (
                <React.Fragment key={key}>
                  <div className="cbw-grouphead" title={collapsed ? t('panel.expand') : t('panel.collapse')} onClick={() => toggleCollapse(key)}>
                    <span className={'cbw-caret' + (collapsed ? ' col' : '')}>▾</span>
                    <span className="cbw-grouptitle">{title}</span>
                    <span className="cbw-groupcount">{g.sessionIds.length}</span>
                  </div>
                  {collapsed
                    ? null
                    : g.sessionIds.map((sid) => {
                        const info = infoOf(state, sid)
                        const onCanvas = !!nodePos[sid]
                        const b = bridgeRowOf(sid)
                        const running = !!(b?.pairId && liveStatus[b.pairId] === 'running')
                        return (
                          <div
                            key={sid}
                            className={'cbw-item' + (onCanvas ? ' on' : '')}
                            title={sid}
                            draggable
                            onDragStart={(e) => {
                              try {
                                e.dataTransfer.setData('text/cb-session', sid)
                                e.dataTransfer.setData('text/plain', sid)
                                e.dataTransfer.effectAllowed = 'copy'
                              } catch {
                                /* ignore */
                              }
                            }}
                          >
                            <div className="cbw-itemTitle">
                              {running ? <span className="cbw-dotrun" /> : null}
                              {info.title}
                            </div>
                            <div className="cbw-itemMeta">{info.model || sid.slice(0, 12)}</div>
                          </div>
                        )
                      })}
                </React.Fragment>
              )
            })}
          </div>

          {/* RIGHT: fixed, independently-scrollable canvas */}
          <div
            className="cbw-right"
            onDragOver={(e) => {
              e.preventDefault()
              try {
                e.dataTransfer.dropEffect = 'copy'
              } catch {
                /* ignore */
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              let sid = ''
              try {
                sid = e.dataTransfer.getData('text/cb-session') || e.dataTransfer.getData('text/plain')
              } catch {
                /* ignore */
              }
              if (!sid || !state.byId[sid]) return
              const r = canvasRef.current!.getBoundingClientRect()
              addNode(sid, e.clientX - r.left, e.clientY - r.top)
            }}
          >
            <div
              className="cbw-canvas"
              ref={canvasRef}
              style={{ width: maxX, height: maxY }}
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              onPointerLeave={() => {
                setNodeDrag(null)
                setEdgeDrag(null)
              }}
              onPointerDown={(e) => {
                if (e.target === canvasRef.current) setSelected(null)
              }}
            >
              <svg width={maxX} height={maxY} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
                <defs>
                  {(['', '-run', '-sel'] as const).map((suffix, idx) => (
                    <marker key={suffix} id={'cbw-ah' + suffix} markerWidth={10} markerHeight={10} refX={8} refY={3} orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L8,3 L0,6 Z" fill={['#9aa0ab', '#2fbf71', '#4f7cff'][idx]} />
                    </marker>
                  ))}
                </defs>
                <g>
                  {renderEdges.map((e) => {
                    const pairId = `${e.from}::${e.to}`
                    const o = outPt(nodePos[e.from])
                    const i = inPt(nodePos[e.to])
                    const d = edgePath(o.x, o.y, i.x, i.y)
                    const running = liveStatus[pairId] === 'running'
                    const isSel = pairId === selected
                    const stroke = isSel ? '#4f7cff' : running ? '#2fbf71' : '#9aa0ab'
                    const marker = isSel ? 'url(#cbw-ah-sel)' : running ? 'url(#cbw-ah-run)' : 'url(#cbw-ah)'
                    return (
                      <g key={pairId}>
                        {/* fat invisible hit path: easy to click, only pointer target */}
                        <path
                          d={d}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={18}
                          style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setSelected(pairId)
                          }}
                        />
                        {/* visible path: styling only, never intercepts clicks */}
                        <path
                          className={running ? 'cbw-edge-run' : ''}
                          d={d}
                          fill="none"
                          stroke={stroke}
                          strokeWidth={isSel ? 3 : 2}
                          strokeDasharray={running ? '6 4' : '0'}
                          markerEnd={marker}
                          style={{ pointerEvents: 'none' }}
                        />
                      </g>
                    )
                  })}
                  {edgeDrag && nodePos[edgeDrag.from] ? (
                    <path d={edgePath(outPt(nodePos[edgeDrag.from]).x, outPt(nodePos[edgeDrag.from]).y, edgeDrag.x, edgeDrag.y)} fill="none" stroke="#4f7cff" strokeWidth={2} strokeDasharray="4 4" />
                  ) : null}
                </g>
              </svg>
              {renderNodes.map((n) => {
                const info = infoOf(state, n.id)
                const dragging = nodeDrag?.id === n.id
                return (
                  <div key={n.id} className={'cbw-cnode' + (dragging ? ' drag' : '')} style={{ left: n.x, top: n.y }} onPointerDown={(e) => onNodeDown(n.id, e)}>
                    <span
                      className="cbw-crm"
                      title={t('panel.delete')}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeNode(n.id)
                      }}
                    >
                      ×
                    </span>
                    <div className="cbw-cnodeTitle">{info.title}</div>
                    <div className="cbw-cnodeMeta">{info.model || n.id.slice(0, 12)}</div>
                    <span className={'cbw-cstatus ' + (info.running ? 'cbw-run' : 'cbw-stop')} />
                    <span className="cbw-cin" />
                    <span className="cbw-cdot" title={t('panel.hint')} onPointerDown={(e) => onDotDown(n.id, e)} />
                  </div>
                )
              })}
            </div>
            {renderNodes.length === 0 ? <div className="cbw-canvashint">{t('panel.dragHint')}</div> : null}
            {selEdge && selFrom && selTo ? (
              <div className="cbw-edgebox" onPointerDown={(e) => e.stopPropagation()}>
                <div className="cbw-edgetitle">{selFrom.title}  →  {selTo.title}</div>
                <div className="cbw-row" style={{ marginBottom: 8 }}>
                  <label className="cbw-badge">
                    <input type="checkbox" checked={!!selEdge.oneway} onChange={(e) => setEdgeOneway(selEdge.from, selEdge.to, e.target.checked)} style={{ marginRight: 6 }} />
                    {t('panel.oneway')}
                  </label>
                </div>
                <div className="cbw-field">
                  <label>{t('panel.firstSpeaker')}</label>
                  <select value={firstSpeaker} onChange={(e) => setFirstSpeaker(e.target.value as 'source' | 'target')}>
                    <option value="source">{t('panel.source') + ' · ' + selFrom.title}</option>
                    <option value="target">{t('panel.target') + ' · ' + selTo.title}</option>
                  </select>
                </div>
                <div className="cbw-field">
                  <label>{t('panel.maxTurns')}</label>
                  <input type="number" min={1} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
                </div>
                <div className="cbw-field">
                  <label>{t('panel.seed')}</label>
                  <input type="text" value={seed} placeholder="我们来辩论：Vim vs Emacs" onChange={(e) => setSeed(e.target.value)} />
                </div>
                <div className="cbw-row" style={{ marginBottom: 8 }}>
                  <label className="cbw-badge">
                    <input type="checkbox" checked={prefix} onChange={(e) => setPrefix(e.target.checked)} style={{ marginRight: 6 }} />
                    {t('panel.prefix')}
                  </label>
                </div>
                <div className="cbw-row">
                  {selRunning ? (
                    <button className="cbw-btn stop" onClick={() => doStop(selEdge)}>{t('panel.stop')}</button>
                  ) : (
                    <button className="cbw-btn primary" onClick={() => doStart(selEdge, opener)}>{t('panel.start')}</button>
                  )}
                  {edgeConnected ? (
                    <button className="cbw-btn ghost" onClick={() => doSetTurns(selEdge)}>{t('panel.applyTurns')}</button>
                  ) : null}
                  <button className="cbw-btn ghost" onClick={() => doDelete(selEdge)}>{t('panel.deleteEdge')}</button>
                  <span className="cbw-badge">{selRunning ? t('panel.running') : t('panel.idle')}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- slot component --------------------------------------------------------
function BridgeAction(props: ActionProps) {
  const { useSessions, useWorkspaces, execute, t } = props
  const idRef = React.useRef<string | null>(null)
  if (idRef.current === null) idRef.current = 'cb-' + ++instanceCounter
  const myId = idRef.current
  const [, force] = React.useState(0)
  React.useEffect(() => openStore.sub(() => force((n) => n + 1)), [])
  const isOpen = openStore.get() === myId

  const state: SessionsState = {
    byId: useSessions((s) => s.byId),
    projectionsBySession: useSessions((s) => s.projectionsBySession),
    phase: '',
  }
  // useWorkspaces is injected into slot components just like useSessions; guard
  // anyway so an absent store degrades to "all ungrouped".
  const workspaces: WorkspacesState = typeof useWorkspaces === 'function' ? useWorkspaces((s) => s) : { items: [], phase: 'ready' }

  // The badge only subscribes to the store to re-render; it no longer drives
  // the poller. Bridge state is produced only by the canvas panel's
  // operations/polling within this session, and after an app restart the host's
  // in-memory state is cleared (0), so reading the store is enough.
  const [, bumpBridge] = React.useState(0)
  React.useEffect(() => bridgeStore.sub(() => bumpBridge((n) => n + 1)), [])
  // badge: number of distinct running bridges
  const runningSet = new Set<string>()
  for (const r of bridgeStore.get()) if (r?.pairId && r.status === 'running') runningSet.add(r.pairId)
  const runningCount = runningSet.size

  return (
    <>
      <button className="cbw-trigger" title={t('panel.title')} onClick={() => openStore.set(isOpen ? null : myId)}>
        🔗 {t('panel.trigger')}
        {runningCount > 0 ? <span className="cbw-badge"> {runningCount}</span> : null}
      </button>
      {isOpen
        ? ReactDOM.createPortal(<Overlay t={t} execute={execute} state={state} workspaces={workspaces} onClose={() => openStore.set(null)} />, document.body)
        : null}
    </>
  )
}

export function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }), 'dsh-conversation-bridge: dictionaries')
  const actions = {
    execute: (sessionId: string, line: string) => ctx.remote.commands.execute(sessionId, line, []),
  }
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'dsh-conversation-bridge', order: -15, locale: NS, inject: () => actions },
      BridgeAction,
    ),
  )
}

// Dictionaries are bundled inline so the client half is standalone.
const enDict = {
  'panel.title': 'Conversation Bridge',
  'panel.trigger': 'Bridge',
  'panel.empty': 'Open at least two sessions to bridge them.',
  'panel.hint': "Drag from one node's dot to another to create a bridge.",
  'panel.maxTurns': 'Max turns',
  'panel.seed': 'Seed (first message)',
  'panel.prefix': 'Prefix peer label',
  'panel.start': 'Start',
  'panel.stop': 'Stop',
  'panel.delete': 'Delete',
  'panel.running': 'running',
  'panel.idle': 'idle',
  'panel.close': 'Close',
  'panel.connect': 'Connect',
  'panel.connectHere': 'Connect here',
  'panel.pickTarget': 'Pick target… (click again to cancel)',
  'panel.picking': 'Click another session to connect (click Connect to cancel)',
  'panel.ungrouped': 'Ungrouped',
  'panel.firstSpeaker': 'First speaker',
  'panel.oneway': 'One-way',
  'panel.deleteEdge': 'Delete',
  'panel.dragHint': 'Drag a session onto the canvas to connect',
  'panel.collapse': 'Collapse',
  'panel.expand': 'Expand',
  'panel.source': 'Source',
  'panel.target': 'Target',
  'panel.applyTurns': 'Apply turns',
}
const zhDict = {
  'panel.title': '对话桥',
  'panel.trigger': '对话桥',
  'panel.empty': '至少打开两个会话才能连线。',
  'panel.hint': '从一个节点的圆点拖到另一个节点即可建立对话桥。',
  'panel.maxTurns': '最大轮数',
  'panel.seed': '开场白（第一句）',
  'panel.prefix': '附加对端标记',
  'panel.start': '开始',
  'panel.stop': '停止',
  'panel.delete': '删除',
  'panel.running': '进行中',
  'panel.idle': '空闲',
  'panel.close': '关闭',
  'panel.connect': '连接',
  'panel.connectHere': '连到此',
  'panel.pickTarget': '选目标…（再点取消）',
  'panel.picking': '点击另一个会话完成连接（点“连接”可取消）',
  'panel.ungrouped': '未分组',
  'panel.firstSpeaker': '先发方',
  'panel.oneway': '单向',
  'panel.deleteEdge': '删除连线',
  'panel.dragHint': '把会话拖到右侧画布连线',
  'panel.collapse': '折叠',
  'panel.expand': '展开',
  'panel.source': '源',
  'panel.target': '目标',
  'panel.applyTurns': '应用轮次',
}
