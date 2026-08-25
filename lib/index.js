/**
 * dsh-manual-compact — host face.
 *
 * Registers the `manual-compact` settings namespace as the Client<->Host
 * transport (the same pattern dsh-plugin-proxy uses). The browser half writes
 * a `request` object; this half executes the compaction through the current
 * agent's official compaction seam (`compaction.compactRegion`) and writes the
 * outcome into `lastRun`, clearing the request. Safe boundaries (tool-call
 * pairing, busy session, cancellation) are enforced by the compaction seam.
 */

import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'

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
  })]).default(null),
  lastRun: z.union([z.const(null), z.object({
    at: z.number(),
    keep: z.number(),
    mode: z.string(),
    ok: z.boolean(),
    shadowed: z.number(),
    message: z.string(),
  })]).default(null),
})

/**
 * Run one manual compaction request against the requesting session.
 * @param ctx - registrant context (logger only).
 * @param agents - live agent registry; resolves the session's agent.
 * @param request - validated request payload.
 * @returns the outcome: ok, shadowed item count, and a human message.
 */
async function executeCompact(ctx, agents, request) {
  const agent = agents.get(request.sessionId)
  const compaction = agent && agent.ctx && agent.ctx.get('compaction')
  if (!agent || !compaction) {
    return { ok: false, shadowed: 0, message: '当前会话暂时没有可用的压缩服务。' }
  }
  try {
    let total = 0
    while (true) {
      const nodes = agent.session.surface.nodes
      if (!Array.isArray(nodes) || nodes.length <= request.keep) break
      const endIndex = Math.min(nodes.length - request.keep - 1, request.mode === 'batch' ? 19 : nodes.length - request.keep - 1)
      if (endIndex < 0) break
      const result = await compaction.compactRegion(nodes[0], nodes[endIndex], agent)
      total += result.shadowedSeqs.length
      if (request.mode !== 'batch') break
    }
    return {
      ok: true,
      shadowed: total,
      message: total
        ? `已压缩 ${total} 条历史，保留最近 ${request.keep} 条。`
        : `没有可压缩的历史，已保留最近 ${request.keep} 条。`,
    }
  } catch (error) {
    const messages = {
      busy: '当前正在压缩或模型仍在工作，请稍后再试。',
      changed: '会话发生变化，本次压缩已停止。',
      summary: '无法生成有效摘要，本次压缩已停止。',
      commit: '压缩提交未完成。',
      persistence: '摘要生成完成，但保存会话失败。',
    }
    return { ok: false, shadowed: 0, message: messages[error && error.code] || `压缩失败：${error && error.message ? error.message : String(error)}` }
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
  const handle = () => {
    if (handling !== null) return
    handling = (async () => {
      try {
        const current = getter()
        const request = current && current.request
        if (request === null || request === undefined || request.nonce === lastHandledNonce) return
        lastHandledNonce = request.nonce
        const result = await executeCompact(ctx, ctx.agents, request)
        await ctx.settings.update(NS, {
          request: null,
          lastRun: {
            at: Date.now(),
            keep: request.keep,
            mode: request.mode,
            ok: result.ok,
            shadowed: result.shadowed,
            message: result.message,
          },
        })
      } catch (error) {
        ctx.logger.warn('manual-compact: handling a request failed: %s', String(error))
      } finally {
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
