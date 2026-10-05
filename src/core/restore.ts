import { compareUtf16, solvePlan } from './analyze'
import { jointCommitmentByNode } from './commitment'
import { GapDiagnosis, minimumCommitmentGapByNode } from './gap'
import { Network } from './types'

/**
 * 单管复通建议（显式生成；建议与见证都不是已应用结果）。
 *
 * 暴雨抢修只能先复通一条已停用管段时，调度员需要知道「复通哪一条最能缩小
 * 安置点承诺缺口」。本模块从当前停用管段中按 id（UTF-16 升序）取至多
 * RESTORE_CANDIDATE_LIMIT 条候选，每条候选都在**互不污染的方案副本**上单独
 * 恢复（solvePlan 重新建模，不改写当前方案的 flow/residual 与停用集合），
 * 并沿现有的三条数据流求出该候选自身的结论：
 *
 *   1. 最大流（solvePlan）：复通后网络的最大总供水量；
 *   2. 联合承诺（jointCommitmentByNode）：复通后全部承诺能否同时兑现；
 *   3. 最小承诺缺口（minimumCommitmentGapByNode）：复通后在「总送水量 =
 *      复通后最大值」约束下的最小总缺口与完整流量见证。
 *
 * 候选按 总缺口升序 → 总供水量降序 → 管段 id（UTF-16 升序）稳定排序；
 * 页面展示各候选相对当前方案的差额（供水量差额 ≥ 0、缺口差额 ≤ 0 恒成立：
 * 恢复管段只会扩大可行域，且同网络内「总量越大、可达最小缺口越小」）。
 *
 * 确认（采用某候选）时必须逐项核对生成建议所依赖的模型、停用集合与承诺
 * （fingerprint）：任一变化即判过期并拒绝，过期建议不得覆盖现场新操作；
 * 计算或确认失败都保留原方案与报告，不抛出、不改写任何输入。
 */

/** 候选上限：从当前停用管段中按 id 升序取前 20 条评估。 */
export const RESTORE_CANDIDATE_LIMIT = 20

/** 承诺条目（按需求点节点 id；与联合承诺 / 缺口诊断的 ByNode 入口同形）。 */
export interface RestoreCommitmentEntry {
  node: string
  minimum: number
}

/** 单条候选的评估结论（仅为建议，不是已应用结果）。 */
export interface RestoreCandidate {
  /** 候选管段 id（来自当前停用集合）。 */
  arcId: string
  /** 复通后网络的最大总供水量。 */
  maxSupply: number
  /** 复通后在最大总量下的最小总缺口。 */
  totalGap: number
  /** 复通后联合承诺裁决是否可行（沿联合承诺数据流单独裁决）。 */
  jointFeasible: boolean
  /** 供水量差额 = maxSupply − 当前总量（恒 ≥ 0）。 */
  supplyDelta: number
  /** 总缺口差额 = totalGap − 当前总缺口（恒 ≤ 0，负值为改善）。 */
  gapDelta: number
  /** 是否构成改善：缺口下降，或缺口不变且供水量上升。 */
  improves: boolean
  /** 复通后方案的完整缺口诊断（含流量见证；未应用）。 */
  diagnosis: GapDiagnosis
}

/** 一次复通建议的完整评估（生成时刻的不可变快照）。 */
export interface RestoreEvaluation {
  /** 差额基准：生成时当前方案的最大供水量。 */
  currentValue: number
  /** 差额基准：生成时当前方案的最小总缺口。 */
  currentGap: number
  /** 当前停用管段总数（仅计网络中存在的管段）。 */
  disabledCount: number
  /** 实际评估的候选数（≤ RESTORE_CANDIDATE_LIMIT）。 */
  evaluated: number
  /** 停用数超出候选上限时为 true（只评估 id 升序前 20 条）。 */
  truncated: boolean
  /** 有效承诺条数（0 = 无承诺，各候选总缺口恒为 0）。 */
  committed: number
  /** 排序后的候选：总缺口升序 → 总供水量降序 → 管段 id UTF-16 升序。 */
  candidates: RestoreCandidate[]
  /** 至少一条候选构成改善。 */
  anyImprovement: boolean
  /** 推荐管段 id（排序第一且确有改善；无改善或无候选时为 null）。 */
  recommended: string | null
}

/** 已生成的建议会话：评估快照 + 其所依赖输入的指纹（确认时逐项核对）。 */
export interface RestoreSession {
  evaluation: RestoreEvaluation
  /** 生成建议所依赖的模型、停用集合与承诺的规范指纹。 */
  fingerprint: string
}

export type RestoreSuggestionResult =
  | { ok: true; session: RestoreSession }
  | { ok: false; reason: string }

export type RestoreConfirmResult =
  | { ok: true; arcId: string; disabled: string[] }
  | { ok: false; reason: string }

/** 候选排序：总缺口最小优先，其次总供水量最大，最后管段 id UTF-16 升序。 */
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
 * 建议所依赖输入的规范指纹：模型（节点/管段/供水/需求，按声明顺序）、
 * 停用集合（id 升序）、承诺（`节点=下限` 升序，与填写顺序无关）。
 * 任一变化即产生不同指纹，确认时据此判过期。
 */
export function restoreFingerprint(
  network: Network,
  disabled: ReadonlySet<string>,
  entries: ReadonlyArray<RestoreCommitmentEntry>,
): string {
  const nodes = network.nodes.map((n) => n.id).join('|')
  const arcs = network.arcs
    .map((a) => `${a.id}=${a.from}>${a.to}:${a.capacity}`)
    .join('|')
  const sources = network.sources.map((s) => `${s.node}:${s.capacity}`).join('|')
  const sinks = network.sinks.map((k) => `${k.node}:${k.capacity}`).join('|')
  const dis = Array.from(disabled).sort(compareUtf16).join('|')
  const ent = entries
    .map((e) => `${e.node}=${e.minimum}`)
    .sort(compareUtf16)
    .join('|')
  return [nodes, arcs, sources, sinks, dis, ent].join('#')
}

/**
 * 生成单管复通建议。
 *
 * 当前方案与每条候选都在各自独立的方案副本上求解（互不污染）；入参
 * （网络、停用集合、承诺）一律只读。任何一步辅助求解失败都整体返回
 * { ok:false, reason }，不产出半截建议，不抛出。
 */
export function generateRestoreSuggestion(
  network: Network,
  disabled: ReadonlySet<string>,
  entries: ReadonlyArray<RestoreCommitmentEntry>,
): RestoreSuggestionResult {
  try {
    // 差额基准：当前方案（独立副本）的最大供水量与最小总缺口。
    const current = solvePlan(network, disabled)
    const currentGap = minimumCommitmentGapByNode(current, entries)
    if (!currentGap.ok) return { ok: false, reason: currentGap.reason }

    // 候选 = 当前停用管段（仅计网络中存在的）按 id 升序的前 20 条。
    const arcIds = new Set(network.arcs.map((a) => a.id))
    const disabledSorted = Array.from(disabled)
      .filter((id) => arcIds.has(id))
      .sort(compareUtf16)
    const chosen = disabledSorted.slice(0, RESTORE_CANDIDATE_LIMIT)

    const candidates: RestoreCandidate[] = []
    for (const arcId of chosen) {
      // 互不污染的方案副本：恢复该候选一条，整体重新建模求解。
      const restored = new Set(disabled)
      restored.delete(arcId)
      const solution = solvePlan(network, restored)

      const joint = jointCommitmentByNode(solution, entries)
      if (!joint.ok && joint.reason !== 'joint-lower-bounds-infeasible') {
        return {
          ok: false,
          reason: `候选 "${arcId}" 联合承诺裁决失败：${joint.reason}`,
        }
      }
      const gap = minimumCommitmentGapByNode(solution, entries)
      if (!gap.ok) {
        return {
          ok: false,
          reason: `候选 "${arcId}" 缺口诊断失败：${gap.reason}`,
        }
      }

      const maxSupply = solution.analysis.value
      const totalGap = gap.totalGap
      const supplyDelta = maxSupply - current.analysis.value
      const gapDelta = totalGap - currentGap.totalGap
      candidates.push({
        arcId,
        maxSupply,
        totalGap,
        jointFeasible: joint.ok,
        supplyDelta,
        gapDelta,
        improves: gapDelta < 0 || (gapDelta === 0 && supplyDelta > 0),
        diagnosis: {
          total: gap.total,
          totalGap: gap.totalGap,
          committed: gap.committed,
          allocations: gap.allocations,
          witness: gap.witness,
        },
      })
    }

    candidates.sort(compareRestoreCandidates)
    const anyImprovement = candidates.some((c) => c.improves)
    const recommended =
      anyImprovement && candidates.length > 0 ? candidates[0].arcId : null

    const evaluation: RestoreEvaluation = {
      currentValue: current.analysis.value,
      currentGap: currentGap.totalGap,
      disabledCount: disabledSorted.length,
      evaluated: chosen.length,
      truncated: disabledSorted.length > chosen.length,
      committed: entries.length,
      candidates,
      anyImprovement,
      recommended,
    }
    return {
      ok: true,
      session: {
        evaluation,
        fingerprint: restoreFingerprint(network, disabled, entries),
      },
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 确认采用某候选：逐项核对生成建议所依赖的模型、停用集合与承诺。
 *
 * 指纹不一致（生成后现场已有新操作）或管段不在本次候选中时，返回
 * { ok:false, reason }，调用方必须保留原方案与报告——过期建议不得覆盖
 * 现场新操作。成功时只返回「移除该管段后的新停用集合」（id 升序），
 * 是否应用由调用方决定；本函数不改写任何入参。
 */
export function confirmRestoreSuggestion(
  session: RestoreSession,
  network: Network,
  disabled: ReadonlySet<string>,
  entries: ReadonlyArray<RestoreCommitmentEntry>,
  arcId: string,
): RestoreConfirmResult {
  try {
    if (!session || typeof arcId !== 'string' || arcId === '') {
      return { ok: false, reason: '确认请求无效，未改动任何方案' }
    }
    const current = restoreFingerprint(network, disabled, entries)
    if (current !== session.fingerprint) {
      return {
        ok: false,
        reason: '建议已过期：模型、停用集合或承诺在生成后已变化，未改动任何方案',
      }
    }
    if (!session.evaluation.candidates.some((c) => c.arcId === arcId)) {
      return {
        ok: false,
        reason: `管段 "${arcId}" 不在本次建议候选中，未改动任何方案`,
      }
    }
    if (!disabled.has(arcId)) {
      return {
        ok: false,
        reason: `管段 "${arcId}" 不在当前停用集合中，未改动任何方案`,
      }
    }
    const next = Array.from(disabled)
      .filter((id) => id !== arcId)
      .sort(compareUtf16)
    return { ok: true, arcId, disabled: next }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
