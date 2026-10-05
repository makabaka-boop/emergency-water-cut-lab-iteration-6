import { compareUtf16, solvePlan } from './analyze'
import { GapDiagnosis, GapResult, minimumCommitmentGapByNode } from './gap'
import { Network } from './types'

/**
 * 单管复通建议（opt-in，显式生成；与断管切换、缺口诊断共用同一份承诺输入）。
 *
 * 场景：暴雨抢修队一次只能先复通一条已停用管段，调度员需要知道「复通哪一条
 * 最能缩小安置点承诺缺口」，再决定是否真的改动演练方案。本模块从当前停用
 * 管段中确定性选出至多 MAX_RESTORE_CANDIDATES 条候选（管段 id UTF-16 升序
 * 取前若干条），对每条候选在**互不污染的方案副本**上单独恢复该管段，沿现有
 * 最大流（solvePlan）与最小承诺缺口（minimumCommitmentGapByNode）数据流
 * 整体重算，得到该候选自身的最大总供水量与缺口见证，再按
 *
 *   总缺口最小 → 复通后总供水量最大 → 管段 id UTF-16 升序
 *
 * 稳定排序。页面只展示当前方案与各候选的差额；建议与候选见证都只是评估
 * 结果，**不是已应用结果**——只有显式「确认复通」才会改动停用集合。
 *
 * 确认契约（confirmRestoration）：
 *  - 生成建议时把所依赖的 模型摘要 + 停用集合 + 承诺 固化为签名；
 *  - 确认时用当前输入重算签名，不一致即判**建议已过期**，拒绝改动
 *    （过期建议不得覆盖现场新操作）；
 *  - 签名一致时再实际重算一次复通后的最大流，必须与建议值一致
 *    （复通后最大流核对），否则同样判失败；
 *  - 任何计算或确认失败都返回 ok:false，调用方据此保留原方案与报告。
 *
 * 单调性（排序与展示的可靠前提）：
 *  - 复通只会向网络加回一条边，最大流关于边集单调不减，故 supplyDelta ≥ 0；
 *  - 最小总缺口关于边集单调不增：设当前最优见证 f（总量 V），在复通后的
 *    网络中 f 仍可行；若新最大流 V′ > V，沿 f 残量网络中每条增广路的
 *    「首个 S⇝T 段」增广（不经过任何 T→v 反向需求弧），可把总量提到 V′
 *    且任何需求点水量不减少，故新最小总缺口 ≤ 旧值，即 gapDelta ≤ 0。
 *
 * 明确结果：无停用管段（no-disabled）、无有效承诺（no-commitments）、
 * 候选无改善（no-improvement：最佳候选的总缺口仍不小于当前）各自返回
 * 可区分的状态；候选评估或确认的任何失败都以 ok:false 返回，绝不抛出、
 * 绝不改写入参。
 */

/** 一次建议评估的候选上限（停用管段 id UTF-16 升序取前若干条）。 */
export const MAX_RESTORE_CANDIDATES = 20

/** 参与建议的承诺条目（按需求点节点 id；与联合承诺/缺口诊断同一来源）。 */
export interface RestoreCommitment {
  node: string
  minimum: number
}

/** 当前方案基准：候选差额都相对它计算。 */
export interface RestoreBaseline {
  /** 当前最大供水量（= 当前方案的 analysis.value）。 */
  maxSupply: number
  /** 当前最小总缺口（= 当前方案上同一组承诺的诊断结果）。 */
  totalGap: number
}

/** 一条候选的评估结果（复通该管段后的独立重算，未应用到当前方案）。 */
export interface RestoreCandidate {
  /** 被恢复的那条停用管段 id。 */
  arcId: string
  /** 复通后该候选自身的最大总供水量。 */
  maxSupply: number
  /** 复通后同一组承诺下的最小总缺口。 */
  totalGap: number
  /** 供水差额 = 候选最大供水量 − 当前最大供水量（单调性保证 ≥ 0）。 */
  supplyDelta: number
  /** 缺口差额 = 候选总缺口 − 当前总缺口（单调性保证 ≤ 0；负值即缩小）。 */
  gapDelta: number
  /** 该候选的完整缺口诊断（含流量见证）；仅为评估结果，未应用。 */
  diagnosis: GapDiagnosis
}

/** 评估完成（含「候选无改善」情形）的建议。 */
export interface RestoreAdviceSolved {
  ok: true
  /** ok = 至少一条候选能缩小总缺口；no-improvement = 没有候选能改善。 */
  status: 'ok' | 'no-improvement'
  /** 生成建议所依赖的 模型 + 停用集合 + 承诺 的签名（确认时重算核对）。 */
  signature: string
  /** 当前方案基准。 */
  current: RestoreBaseline
  /** 候选评估结果，按 总缺口↑ / 供水量↓ / 管段 id 稳定排序。 */
  candidates: RestoreCandidate[]
  /** 实际评估的候选条数（≤ maxCandidates）。 */
  evaluated: number
  /** 当前停用管段总数（可能大于 evaluated）。 */
  disabledTotal: number
}

/** 无可评估对象：无停用管段 / 无有效承诺。 */
export interface RestoreAdviceEmpty {
  ok: true
  status: 'no-disabled' | 'no-commitments'
}

export interface RestoreAdviceFailure {
  ok: false
  /** 失败原因（非空字符串）：承诺无效或底层求解/自检异常。 */
  reason: string
}

export type RestoreAdviceResult =
  | RestoreAdviceSolved
  | RestoreAdviceEmpty
  | RestoreAdviceFailure

/** 候选排序：总缺口最小 → 复通后供水量最大 → 管段 id UTF-16 升序。 */
export function compareRestoreCandidates(
  a: RestoreCandidate,
  b: RestoreCandidate,
): number {
  return (
    a.totalGap - b.totalGap ||
    b.maxSupply - a.maxSupply ||
    compareUtf16(a.arcId, b.arcId)
  )
}

/**
 * 网络摘要：对规范化序列化做双种子 FNV-1a（32 位）混合。
 * 仅作同一会话内「模型是否变化」的完整性核对，不是安全散列。
 */
function digestNetwork(network: Network): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x9e3779b9
  const mix = (piece: string): void => {
    for (let i = 0; i < piece.length; i++) {
      const c = piece.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193)
      h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x9e3779b9)
    }
  }
  // 长度前缀 + 分隔符，保证不同切分得到不同串（id 可含任意字符）。
  const field = (s: string): void => {
    mix(s.length.toString(36))
    mix(',')
    mix(s)
    mix(';')
  }
  mix('N')
  for (const n of network.nodes) field(n.id)
  mix('A')
  for (const a of network.arcs) {
    field(a.id)
    field(a.from)
    field(a.to)
    field(String(a.capacity))
  }
  mix('S')
  for (const s of network.sources) {
    field(s.node)
    field(String(s.capacity))
  }
  mix('K')
  for (const k of network.sinks) {
    field(k.node)
    field(String(k.capacity))
  }
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`
}

/** 承诺规范化：按节点 id（UTF-16 升序）再按承诺值排序，与填写顺序无关。 */
function canonicalCommitments(
  commitments: readonly RestoreCommitment[],
): RestoreCommitment[] {
  return [...commitments].sort(
    (a, b) => compareUtf16(a.node, b.node) || a.minimum - b.minimum,
  )
}

/** 长度前缀编码（id 可含任意字符，必须无歧义拼接）。 */
function packFields(fields: readonly string[]): string {
  return fields.map((s) => `${s.length.toString(36)},${s}`).join(';')
}

/**
 * 建议签名：模型摘要 + 停用集合（UTF-16 升序）+ 规范化承诺。
 * 确认时用当前输入重算并逐项比对；任一变化即判建议过期。
 */
export function restoreInputSignature(
  network: Network,
  disabled: ReadonlySet<string>,
  commitments: readonly RestoreCommitment[],
): string {
  const disabledPart = packFields(Array.from(disabled).sort(compareUtf16))
  const commitPart = packFields(
    canonicalCommitments(commitments).flatMap((c) => [c.node, String(c.minimum)]),
  )
  return `${digestNetwork(network)}#${disabledPart}#${commitPart}`
}

/** 去掉 GapResult 的 ok 标记，得到不可变的诊断本体。 */
function toDiagnosis(result: Extract<GapResult, { ok: true }>): GapDiagnosis {
  return {
    total: result.total,
    totalGap: result.totalGap,
    committed: result.committed,
    allocations: result.allocations,
    witness: result.witness,
  }
}

/**
 * 生成单管复通建议（不改变任何状态，纯评估）。
 *
 * 当前方案基准与各候选都沿 现有最大流 + 最小承诺缺口 数据流整体重算；
 * 任一候选评估失败（承诺无效、求解或自检异常）即整体返回 ok:false，
 * 调用方保留原方案与报告。
 */
export function adviseRestoration(
  network: Network,
  disabled: ReadonlySet<string>,
  commitments: readonly RestoreCommitment[],
  maxCandidates: number = MAX_RESTORE_CANDIDATES,
): RestoreAdviceResult {
  try {
    if (disabled.size === 0) return { ok: true, status: 'no-disabled' }
    if (commitments.length === 0) return { ok: true, status: 'no-commitments' }

    // 当前方案基准：最大供水量 + 同一组承诺下的最小总缺口。
    const currentSolution = solvePlan(network, disabled)
    const currentGap = minimumCommitmentGapByNode(currentSolution, commitments)
    if (!currentGap.ok) return { ok: false, reason: currentGap.reason }
    const current: RestoreBaseline = {
      maxSupply: currentSolution.analysis.value,
      totalGap: currentGap.totalGap,
    }

    // 候选：停用管段 id UTF-16 升序取前 maxCandidates 条（完全确定）。
    const orderedDisabled = Array.from(disabled).sort(compareUtf16)
    const limit = Math.max(0, Math.min(maxCandidates, orderedDisabled.length))
    const picked = orderedDisabled.slice(0, limit)

    const candidates: RestoreCandidate[] = []
    for (const arcId of picked) {
      // 互不污染的方案副本：每个候选独立整体重算，不回写当前方案。
      const restored = new Set(disabled)
      restored.delete(arcId)
      const candidateSolution = solvePlan(network, restored)
      const gap = minimumCommitmentGapByNode(candidateSolution, commitments)
      if (!gap.ok) return { ok: false, reason: gap.reason }
      candidates.push({
        arcId,
        maxSupply: candidateSolution.analysis.value,
        totalGap: gap.totalGap,
        supplyDelta: candidateSolution.analysis.value - current.maxSupply,
        gapDelta: gap.totalGap - current.totalGap,
        diagnosis: toDiagnosis(gap),
      })
    }

    candidates.sort(compareRestoreCandidates)
    const best = candidates[0]
    const improves = best !== undefined && best.totalGap < current.totalGap
    return {
      ok: true,
      status: improves ? 'ok' : 'no-improvement',
      signature: restoreInputSignature(network, disabled, commitments),
      current,
      candidates,
      evaluated: candidates.length,
      disabledTotal: disabled.size,
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 确认成功：返回应采用的停用集合（UTF-16 升序）与核对后的结果。 */
export interface RestoreConfirmOk {
  ok: true
  arcId: string
  /** 确认后的停用集合（= 原集合去掉被复通管段），UTF-16 升序。 */
  disabled: string[]
  /** 复通后最大供水量（已实际重算核对，与建议一致）。 */
  maxSupply: number
  /** 复通后同一组承诺下的最小总缺口（来自候选评估）。 */
  totalGap: number
}

export interface RestoreConfirmFailure {
  ok: false
  /** 失败原因（非空字符串）：建议过期、候选不存在或复通后最大流不符。 */
  reason: string
}

export type RestoreConfirmResult = RestoreConfirmOk | RestoreConfirmFailure

/**
 * 确认复通一条候选管段。
 *
 * 先用当前 模型 + 停用集合 + 承诺 重算签名并与建议签名比对：不一致即
 * 「建议已过期」，拒绝改动（过期建议不得覆盖现场新操作）；签名一致时
 * 实际重算复通后的最大流并与建议值核对（复通后最大流改变必须被识别）。
 * 任何失败都返回 ok:false 且不产生新停用集合，调用方保留原方案与报告。
 * 本函数为纯函数：不改写 network、advice 与 current。
 */
export function confirmRestoration(
  network: Network,
  advice: RestoreAdviceSolved,
  arcId: string,
  current: {
    disabled: ReadonlySet<string>
    commitments: readonly RestoreCommitment[]
  },
): RestoreConfirmResult {
  try {
    const live = restoreInputSignature(
      network,
      current.disabled,
      current.commitments,
    )
    if (live !== advice.signature) {
      return {
        ok: false,
        reason: '建议已过期：模型、停用集合或承诺已变化，未改动当前方案',
      }
    }
    const candidate = advice.candidates.find((c) => c.arcId === arcId)
    if (!candidate) {
      return {
        ok: false,
        reason: `管段 "${arcId}" 不在本建议的候选中，未改动当前方案`,
      }
    }
    if (!current.disabled.has(arcId)) {
      return {
        ok: false,
        reason: `管段 "${arcId}" 当前并未停用，未改动当前方案`,
      }
    }
    const next = new Set(current.disabled)
    next.delete(arcId)
    // 复通后最大流核对：实际重算必须与建议一致，否则判失败并保留原方案。
    const verify = solvePlan(network, next)
    if (verify.analysis.value !== candidate.maxSupply) {
      return {
        ok: false,
        reason: '复通后最大供水量与建议不一致，未改动当前方案',
      }
    }
    return {
      ok: true,
      arcId,
      disabled: Array.from(next).sort(compareUtf16),
      maxSupply: candidate.maxSupply,
      totalGap: candidate.totalGap,
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
