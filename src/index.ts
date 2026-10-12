/**
 * @deepseek-ai/dsh-conversation-bridge — HOST half (authoritative TypeScript source).
 *
 * Compiles to ../lib/index.js (the prebuilt ESM artifact the loader mounts).
 * Keep behaviour in sync with that file. See the README for the full list of
 * verified ctx services / events / projection APIs this relies on.
 *
 * Design in one line: link two *independent, already-live* top-level sessions so
 * each full reply from one is delivered to the other as a user message, bouncing
 * back and forth until `maxTurns` relayed messages or an explicit stop.
 *
 * This plugin is installed OUTSIDE the profile tree (as a `file:` dependency
 * copied into the profile). `@deepseek-ai/cordis` is bundled inside app.asar and
 * is NOT resolvable from the profile's module tree, and the dsh loader imports
 * plugin host halves through Node's chained ESM loader WITHOUT a custom resolve
 * hook for nested bare imports — so importing cordis here would fail with
 * ERR_MODULE_NOT_FOUND and the host row would throw on load. We therefore ship a
 * FUNCTIONAL plugin with ZERO imports (no `Service` subclass, nothing from
 * cordis). We never inject `ctx.dshConversationBridge`, so a Service is unneeded.
 *
 * Bridge state is kept IN MEMORY ONLY and is never written to the session log.
 * The public `session.append(type,data,opts)` has no way to mark a custom event
 * `ignorable`, so any `bridge/*` event in the log makes the harness refuse to
 * load the whole session on restart. The client therefore reads state by
 * polling the `/bridge status --json` command instead of a session projection.
 */

// The dsh type packages ship compiled JS only (no .d.ts) in the developer
// preview, so the service surfaces we touch are declared structurally here.
// Every member below was read from the shipped compiled sources.

interface Agent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: { id: string }
  /** Queue input as the next-turn user prompt and wake the driver. */
  followup(input: UserMessage): void
}

interface UserMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' }
}

interface SessionEvent {
  type: string
  seq: number
  data: unknown
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<{ type: string; text?: string }>
}

interface Session {
  readonly id: string
  deriveMessages(): Message[]
}

interface Ctx {
  logger?: { warn?: (msg: string) => void }
  agents: { get(id: string): Agent | undefined; list(): Agent[] }
  sessions: { get(id: string): Session | undefined }
  on(event: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void
  effect(fn: () => void | (() => void), label?: string): void
  inject(deps: string[], fn: (ctx: Ctx & { commands: Commands }) => void): void
}

interface Commands {
  register(def: {
    name: string
    description: string
    input: { hint: string }
    handler: (args: { agent?: Agent; rawInput: string }) => CommandResult | Promise<CommandResult>
  }): void
}

type CommandResult = { kind: 'success' | 'error'; text: string }

interface BridgeConfig {
  defaultMaxTurns?: number
  prefixPeerLabel?: boolean
}

interface BridgeRecord {
  pairId: string
  aId: string
  bId: string
  status: 'idle' | 'running'
  turn: number
  maxTurns: number
  prefix: boolean
  lastFrom: string | null
  /** 'both' relays A<->B; 'oneway' relays only A(source)->B. */
  mode: 'both' | 'oneway'
}

function messageText(message: Message | null): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim()
}

function tokenize(raw: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) tokens.push(m[1] !== undefined ? m[1] : m[2])
  return tokens
}

/**
 * Relay plugin. One closure instance per host; both the `/bridge` command and
 * the canvas (via `ctx.remote.commands.execute(..., '/bridge ...')`) drive this
 * same instance, so CLI and canvas share identical behaviour.
 */
function dshConversationBridge(ctx: Ctx, rawConfig: BridgeConfig = {}): void {
  const config: Required<BridgeConfig> = {
    defaultMaxTurns:
      Number.isSafeInteger(rawConfig.defaultMaxTurns) && (rawConfig.defaultMaxTurns as number) > 0
        ? (rawConfig.defaultMaxTurns as number)
        : 6,
    prefixPeerLabel: rawConfig.prefixPeerLabel === true,
  }

  /** pairId -> record */
  const bridges = new Map<string, BridgeRecord>()
  /** sessionId -> pairId (enforces "a session is in at most one bridge") */
  const bySession = new Map<string, string>()
  /** pairId -> `ctx.on('session/event')` disposer (present only while running) */
  const listeners = new Map<string, () => void>()
  /** pairId re-entry guard so one turn/end can't be relayed twice concurrently */
  const busy = new Set<string>()

  // ----- resolution helpers ------------------------------------------------

  const pairKey = (aId: string, bId: string) => `${aId}::${bId}`

  /** Resolve a record by pairId, or by any member session id. */
  function resolve(ref: string): BridgeRecord | undefined {
    if (bridges.has(ref)) return bridges.get(ref)
    const pairId = bySession.get(ref)
    return pairId ? bridges.get(pairId) : undefined
  }

  // ----- control surface (shared by command + client RPC) ------------------

  /** Create an idle bridge between two live sessions.
   *  Options: { oneway } — a one-way bridge relays only the source (A) side. */
  async function connect(aId: string, bId: string, options: { oneway?: boolean } = {}): Promise<BridgeRecord> {
    if (!aId || !bId || aId === bId) throw new Error('connect needs two distinct session ids')
    if (!ctx.sessions.get(aId)) throw new Error(`session not found: ${aId}`)
    if (!ctx.sessions.get(bId)) throw new Error(`session not found: ${bId}`)
    if (bySession.has(aId)) throw new Error(`session ${aId} is already bridged`)
    if (bySession.has(bId)) throw new Error(`session ${bId} is already bridged`)

    const pairId = pairKey(aId, bId)
    const record: BridgeRecord = {
      pairId,
      aId,
      bId,
      status: 'idle',
      turn: 0,
      maxTurns: config.defaultMaxTurns,
      prefix: config.prefixPeerLabel,
      lastFrom: null,
      // pairKey stays `${aId}::${bId}` (directed, unsorted) so nothing else changes.
      mode: options.oneway ? 'oneway' : 'both',
    }
    bridges.set(pairId, record)
    bySession.set(aId, pairId)
    bySession.set(bId, pairId)
    return record
  }

  /** Start (or restart) relaying. Options: { maxTurns, seed, prefix, from }. */
  async function start(
    ref: string,
    options: { maxTurns?: number; seed?: string; prefix?: boolean; from?: string } = {},
  ): Promise<BridgeRecord> {
    const record = resolve(ref)
    if (!record) throw new Error('no bridge for that reference; connect first')
    if (record.status === 'running') return record

    const agentA = ctx.agents.get(record.aId)
    const agentB = ctx.agents.get(record.bId)
    if (!agentA || !agentB) throw new Error('both sessions must be open (live agents) before starting')

    if (Number.isSafeInteger(options.maxTurns) && (options.maxTurns as number) > 0) {
      record.maxTurns = options.maxTurns as number
    }
    if (typeof options.prefix === 'boolean') record.prefix = options.prefix
    record.turn = 0
    record.lastFrom = null
    record.status = 'running'

    // The "opener" is the session that speaks first. --from <id> picks either
    // member; anything else (incl. unset) defaults to aId, so legacy callers
    // that never pass --from behave exactly as before.
    const opener =
      options.from === record.aId || options.from === record.bId ? options.from : record.aId

    // Attach the completion listener; it is removed again on stop / maxTurns /
    // unload, so no listener outlives a running bridge.
    const off = ctx.on('session/event', (session, event) => onSessionEvent(record, session, event))
    listeners.set(record.pairId, off)

    const seed = typeof options.seed === 'string' ? options.seed.trim() : ''
    if (seed) {
      // Seed the opener; its reply produces a turn/end that the listener relays
      // to the opener's peer.
      deliver(ctx.agents.get(opener) as Agent, seed, false)
    } else {
      // No seed: kick off from the opener's existing last reply, if any.
      const text = messageText(lastAssistant(opener))
      if (text) await relay(record, opener, text)
    }
    return record
  }

  /** Stop relaying but keep the (idle) bridge so the canvas edge remains. */
  async function stop(ref: string): Promise<BridgeRecord | undefined> {
    const record = resolve(ref)
    if (!record) return undefined
    detach(record.pairId)
    record.status = 'idle'
    return record
  }

  /** Remove a bridge entirely. */
  async function disconnect(ref: string): Promise<BridgeRecord | undefined> {
    const record = resolve(ref)
    if (!record) return undefined
    detach(record.pairId)
    bridges.delete(record.pairId)
    bySession.delete(record.aId)
    bySession.delete(record.bId)
    return record
  }

  /** Plain-JSON snapshot of every bridge (for `status` / debugging). */
  function status() {
    return [...bridges.values()].map((r) => ({
      pairId: r.pairId,
      a: r.aId,
      b: r.bId,
      status: r.status,
      turn: r.turn,
      maxTurns: r.maxTurns,
      prefix: r.prefix,
      lastFrom: r.lastFrom,
      mode: r.mode,
    }))
  }

  // ----- internals ---------------------------------------------------------

  function detach(pairId: string) {
    const off = listeners.get(pairId)
    if (off) {
      off()
      listeners.delete(pairId)
    }
  }

  function stopAll() {
    for (const pairId of [...listeners.keys()]) detach(pairId)
    for (const record of bridges.values()) record.status = 'idle'
  }

  /** Completion signal: a bridged session finished a turn -> relay to its peer. */
  function onSessionEvent(record: BridgeRecord, session: Session, event: SessionEvent) {
    if (record.status !== 'running') return
    if (!event || event.type !== 'turn/end') return
    const sid = session?.id
    if (sid !== record.aId && sid !== record.bId) return
    // One-way bridges relay only the source (A) side; the target's (B) turn/end
    // is observed but never forwarded back. 'both' keeps the two-way behaviour.
    if (record.mode === 'oneway' && sid !== record.aId) return
    if (busy.has(record.pairId)) return

    // Stop before exceeding the cap (don't relay the (maxTurns+1)-th message).
    if (record.turn >= record.maxTurns) {
      void stop(record.pairId)
      return
    }
    const text = messageText(lastAssistant(sid))
    if (!text) return
    void relay(record, sid, text)
  }

  /** Deliver `text` from `fromId`'s reply to the opposite peer, then advance. */
  async function relay(record: BridgeRecord, fromId: string, text: string) {
    busy.add(record.pairId)
    try {
      const peerId = fromId === record.aId ? record.bId : record.aId
      const peerAgent = ctx.agents.get(peerId)
      if (!peerAgent) {
        await stop(record.pairId) // peer closed -> stop cleanly
        return
      }
      deliver(peerAgent, text, record.prefix)
      record.turn += 1
      record.lastFrom = fromId
      if (record.turn >= record.maxTurns) await stop(record.pairId)
    } finally {
      busy.delete(record.pairId)
    }
  }

  /**
   * Queue `text` as the peer's next-turn user input and wake its driver.
   * `followup` is the dsh-agent primitive for exactly this (queue next-turn
   * prompt + wake). The source stays a plain `{kind:'user'}` so it passes the
   * session's strict MessageSource validation; anti-loop safety comes from the
   * turn-counted, single-bridge-per-session design rather than source tagging.
   */
  /** Fresh non-empty message id; the session load path rejects user messages without one. */
  function newMessageId(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    return `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  function deliver(agent: Agent, text: string, prefix: boolean) {
    const body = prefix ? `[对端] ${text}` : text
    agent.followup({
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    })
  }

  function lastAssistant(sessionId: string): Message | null {
    const session = ctx.sessions.get(sessionId)
    if (!session) return null
    let messages: Message[]
    try {
      messages = session.deriveMessages()
    } catch {
      return null
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return messages[i]
    }
    return null
  }

  // ----- command grammar ---------------------------------------------------

  async function handleCommand(agent: Agent | undefined, rawInput: string): Promise<CommandResult> {
    const current = agent?.session?.id
    const tokens = tokenize(rawInput || '')
    const sub = (tokens.shift() || '').toLowerCase()
    try {
      switch (sub) {
        case 'connect': {
          const flags = parseConnectFlags(tokens)
          const [x, y] = flags.ids
          const aId = y ? x : current
          const bId = y ? y : x
          if (!aId || !bId) return { kind: 'error', text: 'usage: /bridge connect <A> <B> [--oneway]' }
          const r = await connect(aId, bId, { oneway: flags.oneway })
          const arrow = r.mode === 'oneway' ? '-->' : '<->'
          return { kind: 'success', text: `Bridged ${r.aId}  ${arrow}  ${r.bId} (idle).` }
        }
        case 'start': {
          const opts = parseStartFlags(tokens)
          const ref = opts.ref || current
          if (!ref) return { kind: 'error', text: 'no bridge for this session' }
          const r = await start(ref, opts)
          return {
            kind: 'success',
            text: `Bridge started: max-turns=${r.maxTurns}, prefix=${r.prefix ? 'on' : 'off'}.`,
          }
        }
        case 'stop': {
          const r = await stop(tokens[0] || current || '')
          return r
            ? { kind: 'success', text: 'Bridge stopped.' }
            : { kind: 'error', text: 'No bridge for this session.' }
        }
        case 'set': {
          // Mutate an existing bridge's turns/prefix WITHOUT sending any message.
          // Never calls deliver/relay/start — only updates in-memory fields.
          let ref: string | undefined
          let maxTurns: number | undefined
          let prefix: boolean | undefined
          for (let i = 0; i < tokens.length; i++) {
            const tk = tokens[i]
            if (tk === '--max-turns' || tk === '-n') maxTurns = Number(tokens[++i])
            else if (tk === '--prefix') prefix = (tokens[++i] || '').toLowerCase() === 'on'
            else if (!ref) ref = tk
          }
          const record = resolve(ref || current || '')
          if (!record) return { kind: 'error', text: 'no bridge for this session' }
          if (maxTurns !== undefined) {
            if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
              return { kind: 'error', text: 'max-turns must be a positive integer' }
            }
            record.maxTurns = maxTurns
          }
          if (prefix !== undefined) record.prefix = prefix
          return { kind: 'success', text: `Bridge updated: max-turns=${record.maxTurns}.` }
        }
        case 'disconnect': {
          const r = await disconnect(tokens[0] || current || '')
          return r
            ? { kind: 'success', text: 'Bridge removed.' }
            : { kind: 'error', text: 'No bridge for this session.' }
        }
        case 'status': {
          const rows = status()
          // 画布客户端通过轮询 `/bridge status --json` 得知有哪些桥、哪些在运行
          // (取代原先的会话投影)。CLI 仍返回人类可读文本。
          if (tokens.indexOf('--json') >= 0) {
            return { kind: 'success', text: JSON.stringify(rows) }
          }
          if (rows.length === 0) return { kind: 'success', text: 'No bridges.' }
          return {
            kind: 'success',
            text: rows
              .map(
                (r) =>
                  `${r.a} ${r.mode === 'oneway' ? '-->' : '<->'} ${r.b} [${r.status}] turn ${r.turn}/${r.maxTurns}` +
                  (r.lastFrom ? ` last:${r.lastFrom}` : ''),
              )
              .join('\n'),
          }
        }
        default:
          return {
            kind: 'error',
            text: 'usage: /bridge connect <A> <B> [--oneway] | start [--from <id>] [--max-turns N] [--seed "..."] [--prefix on|off] | set [--max-turns N] [--prefix on|off] | stop | status',
          }
      }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Parse `connect` tokens: positional ids plus the optional `--oneway` flag. */
  function parseConnectFlags(tokens: string[]): { oneway: boolean; ids: string[] } {
    const opts: { oneway: boolean; ids: string[] } = { oneway: false, ids: [] }
    for (const t of tokens) {
      if (t === '--oneway') opts.oneway = true
      else opts.ids.push(t)
    }
    return opts
  }

  function parseStartFlags(tokens: string[]): {
    ref?: string
    maxTurns?: number
    seed?: string
    prefix?: boolean
    from?: string
  } {
    const opts: { ref?: string; maxTurns?: number; seed?: string; prefix?: boolean; from?: string } = {}
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok === '--max-turns' || tok === '-n') opts.maxTurns = Number(tokens[++i])
      else if (tok === '--seed' || tok === '-s') opts.seed = tokens[++i]
      else if (tok === '--prefix') opts.prefix = (tokens[++i] || '').toLowerCase() === 'on'
      else if (tok === '--from' || tok === '-f') opts.from = tokens[++i]
      else if (!opts.ref) opts.ref = tok
    }
    return opts
  }

  // ----- registration (was the constructor body) ---------------------------

  ctx.effect(() => {
    // 桥接状态只存在于内存,不再写入会话日志,因此没有投影可注册 —— 卸载时
    // 只需拆掉所有在跑的桥(断开全部监听器)。
    return () => {
      stopAll()
    }
  }, 'dshConversationBridge.teardown()')

  // Optional CLI/command surface. Registration is itself a Cordis effect, so
  // it unregisters cleanly on unload. `commands` is optional (absent in some
  // headless profiles), so inject it rather than hard-depend on it.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'bridge',
      description: 'Bridge two sessions into an auto-conversation.',
      input: {
        hint: 'connect <A> <B> [--oneway] | start [--from <id>] [--max-turns N] [--seed "..."] [--prefix on|off] | set [--max-turns N] [--prefix on|off] | stop | status',
      },
      handler: ({ agent, rawInput }) => handleCommand(agent, rawInput),
    })
  })
}

// The plugin name is carried by the function declaration itself
// (`dshConversationBridge`); a function's `name` is read-only in strict/ESM mode,
// so it must come from the declaration, not an `apply.name = …` assignment.
dshConversationBridge.inject = ['agents', 'sessions']

export default dshConversationBridge
