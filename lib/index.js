/**
 * dsh-manual-compact-plugin — host face.
 *
 * Registers the `manual-compact` settings namespace as the Client<->Host
 * transport (the same pattern dsh-plugin-proxy uses). The browser half writes
 * a `request` object with an `action`; this half executes the compaction
 * through the current agent's official compaction seam
 * (`compaction.compactRegion(..., signal)`), supports cancellation via an
 * AbortController, publishes live progress, and appends a readable
 * per-session markdown archive to `$DSH_HOME/manual-compact/<session>.md`.
 * The outcome is published into `lastRun` and the request is cleared.
 */

import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { mkdir, appendFile } from 'node:fs/promises'
import os from 'node:os'

const name = 'dsh-manual-compact-plugin'
const inject = ['settings', 'agents']
const NS = 'manual-compact'

/** Composition-row configuration (also the settings schema). */
const Config = z.object({
  request: z.union([z.const(null), z.object({
    nonce: z.number(),
    sessionId: z.string(),
    keep: z.number(),
    mode: z.union([z.const('stop'), z.const('batch')]),
    action: z.union([z.const('compact'), z.const('cancel')]).default('compact'),
  })]).default(null),
  progress: z.union([z.const(null), z.object({
    nonce: z.number(),
    done: z.number(),
    total: z.number(),
  })]).default(null),
  lastRun: z.union([z.const(null), z.object({
    at: z.number(),
    keep: z.number(),
    mode: z.string(),
    ok: z.boolean(),
    shadowed: z.number(),
    message: z.string(),
    cancelled: z.boolean().default(false),
    file: z.string().default(''),
  })]).default(null),
})

/** Best-effort JSON-friendly timestamp. */
function fmtTime(ms) {
  const d = new Date(ms)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Locate the newest landed compaction node, if any. */
function newestCompactionNode(snapshot) {
  const nodes = snapshot && snapshot.surface && snapshot.surface.nodes
  if (!Array.isArray(nodes)) return null
  let newest = null
  for (const n of nodes) {
    if (n && n.kind === 'compaction') newest = n
  }
  return newest
}

/** Append a readable markdown record for every completed region. */
async function writeArchiveFile(sessionId, keep, mode, records, shadowed) {
  if (!records.length) return ''
  const dir = path(process.env.DSH_HOME || homeDotDsh(), 'manual-compact')
  try { await mkdir(dir, { recursive: true }) } catch { /* best effort */ }
  const file = path(dir, sessionId + '.md')
  const chunks = records.map((r) => [
    `## 压缩记录 · ${fmtTime(r.time)}`,
    `- 保留最近：${keep} 条`,
    `- 压缩：${shadowed} 条 · ~${fmtTokens(r.shadowedTokenCount)} tokens`,
    `- 方式：${mode === 'batch' ? '分批处理直到完成' : '完成一批后停止'}`,
    '',
    r.summary || '',
    '',
    '---',
    '',
  ].join('\n'))
  try { await appendFile(file, chunks.join('\n') + '\n', 'utf8') } catch { /* best effort */ }
  return file
}

function homeDotDsh() {
  return os.homedir() + (process.platform === 'win32' ? '\\.dsh' : '/.dsh')
}
function path(...parts) { return parts.join(process.platform === 'win32' ? '\\' : '/') }
function fmtTokens(v) { return typeof v === 'number' && isFinite(v) ? (v >= 1000 ? Math.round(v / 1000) + 'k' : String(v)) : '?' }

const ERROR_MESSAGES = {
  busy: '当前正在压缩或模型仍在工作，请稍后再试。',
  changed: '会话发生变化，本次压缩已停止。',
  summary: '无法生成有效摘要，本次压缩已停止。',
  commit: '压缩提交未完成。',
  persistence: '摘要生成完成，但保存会话失败。',
}

/** Resolve a live agent for a client-provided session id. */
function resolveAgent(agents, sessionId) {
  if (!agents) return { agent: undefined, diagnostic: '' }
  try {
    let agent = agents.get(String(sessionId))
    if (!agent) {
      // Fall back to scanning the registry by session.$id / session.id.
      const wanted = String(sessionId)
      for (const a of agents.list()) {
        const sess = a && a.session
        const sid = sess && (sess.$id !== undefined ? String(sess.$id) : sess.id !== undefined ? String(sess.id) : '')
        if (sid === wanted) { agent = a; break }
      }
    }
    if (agent) return { agent, diagnostic: '' }
    const ids = (agents.list() || []).map((a) => {
      const sess = a && a.session
      return sess && sess.$id !== undefined ? String(sess.$id) : sess && sess.id !== undefined ? String(sess.id) : '?'
    })
    return { agent: undefined, diagnostic: `未能找到 id=${String(sessionId)} 的活跃会话（当前活跃 agent 数=${(agents.list() || []).length}，其 session id：${ids.length ? ids.join(', ') : '无'}）。` }
  } catch (error) {
    return { agent: undefined, diagnostic: `解析会话失败：${error && error.message ? error.message : String(error)}。` }
  }
}

/**
 * Run one manual compaction request against the requesting session.
 * Supports cancellation through `signal` and reports progress through
 * `onProgress`. Returns the outcome including a readable file path.
 */
async function executeCompact(ctx, agents, request, signal, onProgress) {
  const resolved = resolveAgent(agents, request.sessionId)
  const agent = resolved.agent
  // The compaction provider may be mounted on the host-registrant context
  // (near the root) and take the agent as its target, or directly on the
  // agent's own context. Try both and report exactly which is available.
  const rootCompaction = ctx && typeof ctx.get === 'function' ? ctx.get('compaction') : undefined
  const agentCompaction = agent && agent.ctx && typeof agent.ctx.get === 'function' ? agent.ctx.get('compaction') : undefined
  const compaction = rootCompaction || agentCompaction
  if (!agent || !compaction) {
    const diag = resolved.diagnostic
      || (agent
        ? `compaction 服务不可用（host 根:${rootCompaction ? '有' : '无'}，agent ctx:${agentCompaction ? '有' : '无'}）。`
        : '当前会话暂时没有可用的压缩服务。')
    return { ok: false, shadowed: 0, message: diag, cancelled: false, file: '' }
  }
  const records = []
  try {
    let done = 0
    let total = 0
    while (true) {
      if (signal && signal.aborted) throw { name: 'AbortError' }
      const nodes = agent.session.surface.nodes
      if (!Array.isArray(nodes) || nodes.length <= request.keep) break
      const toCompress = nodes.length - request.keep
      if (total === 0) total = toCompress
      const endIndex = Math.min(toCompress - 1, request.mode === 'batch' ? 19 : toCompress - 1)
      if (endIndex < 0) break
      const result = await compaction.compactRegion(nodes[0], nodes[endIndex], agent, signal)
      done += Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
      const rec = newestCompactionNode(agent.session.surface.nodes)
      if (rec) {
        records.push({ time: rec.time, shadowedItemCount: rec.shadowedItemCount, shadowedTokenCount: rec.shadowedTokenCount, summary: rec.summary })
      }
      if (onProgress) await onProgress({ nonce: request.nonce, done, total })
      if (request.mode !== 'batch') break
    }
    const file = await writeArchiveFile(request.sessionId, request.keep, request.mode, records, done)
    const message = done
      ? `已压缩 ${done} 条历史，保留最近 ${request.keep} 条${done > 0 && file ? `；结果已保存到 ${file}` : ''}。`
      : `没有可压缩的历史，已保留最近 ${request.keep} 条。`
    return { ok: true, shadowed: done, message, cancelled: false, file }
  } catch (error) {
    const cancelled = !!(signal && signal.aborted) || (error && error.name === 'AbortError')
    const reason = cancelled
      ? '已取消压缩。'
      : ERROR_MESSAGES[error && error.code] || `压缩失败：${error && error.message ? error.message : String(error)}`
    return { ok: false, shadowed: 0, message: reason, cancelled, file: '' }
  }
}

/**
 * Cordis plugin body.
 * @param ctx - registrant context (`settings`, `agents`, `logger`).
 * @param config - validated composition configuration.
 */
function apply(ctx, config) {
  let getter = () => config
  let lastHandledNonce = null
  let handling = null
  const controllers = new Map() // sessionId -> AbortController

  const handle = () => {
    const current = getter()
    const request = current && current.request
    if (request === null || request === undefined) return

    // Cancel: abort any active compaction for this session.
    if (request.action === 'cancel') {
      const controller = controllers.get(request.sessionId)
      if (!controller) {
        void ctx.settings.update(NS, { request: null }).catch(() => {})
        return
      }
      controller.abort()
      return // the running task publishes the cancelled lastRun and clears request
    }

    if (handling !== null) return
    if (request.nonce === lastHandledNonce) return
    lastHandledNonce = request.nonce
    handling = (async () => {
      const controller = new AbortController()
      controllers.set(request.sessionId, controller)
      try {
        const onProgress = async (p) => {
          try { await ctx.settings.update(NS, { progress: p }) } catch {}
        }
        const result = await executeCompact(ctx, ctx.agents, request, controller.signal, onProgress)
        await ctx.settings.update(NS, {
          request: null,
          progress: null,
          lastRun: {
            at: Date.now(),
            keep: request.keep,
            mode: request.mode,
            ok: result.ok,
            shadowed: result.shadowed,
            message: result.message,
            cancelled: !!result.cancelled,
            file: result.file || '',
          },
        })
      } catch (error) {
        ctx.logger.warn('manual-compact: handling a request failed: %s', String(error))
        try {
          await ctx.settings.update(NS, {
            request: null,
            progress: null,
            lastRun: { at: Date.now(), keep: request.keep, mode: request.mode, ok: false, shadowed: 0, message: String(error), cancelled: (controller.signal && controller.signal.aborted), file: '' },
          })
        } catch {}
      } finally {
        controllers.delete(request.sessionId)
        handling = null
      }
    })()
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (current) => {
      getter = current
      handle()
    },
    onChange: () => {
      handle()
    },
  })
}

export { Config, apply, inject, name }
