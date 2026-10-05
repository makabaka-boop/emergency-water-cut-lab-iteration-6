import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import { minimumCommitmentGapByNode } from '../src/core/gap'
import {
  RESTORE_CANDIDATE_LIMIT,
  RestoreCandidate,
  confirmRestoreSuggestion,
  generateRestoreSuggestion,
  restoreFingerprint,
} from '../src/core/restore'
import { Network } from '../src/core/types'
import {
  FeasiblePoint,
  enumerateFeasibleFlows,
  mulberry32,
  smallIntervalNetwork,
} from './helpers'

/**
 * 穷举预言机：固定总量 V 的全部可行最大流中，各被承诺需求点的
 * 未达承诺量之和的最小值（与 gap.test.ts 的预言机同口径）。
 */
function oracleMinGap(
  all: FeasiblePoint[],
  V: number,
  mins: (number | null)[],
): number {
  const maxPoints = all.filter((p) => p.total === V)
  expect(maxPoints.length).toBeGreaterThan(0)
  let best = Infinity
  for (const p of maxPoints) {
    let g = 0
    mins.forEach((m, k) => {
      if (m !== null) g += m - Math.min(p.sinkY[k], m)
    })
    if (g < best) best = g
  }
  return best
}

/** 独立校验候选的缺口见证：容量、原节点守恒、超级源汇平衡、逐点水量一致。 */
function expectCandidateWitness(
  net: Network,
  restoredDisabled: ReadonlySet<string>,
  candidate: RestoreCandidate,
): void {
  const solution = solvePlan(net, restoredDisabled)
  const V = solution.analysis.value
  const { diagnosis } = candidate

  expect(candidate.maxSupply).toBe(V)
  expect(diagnosis.total).toBe(V)
  expect(diagnosis.witness.total).toBe(V)
  // 见证边与复通后方案的建模边身份/顺序一一对应。
  expect(diagnosis.witness.edges.length).toBe(solution.edges.length)

  const balance = new Float64Array(solution.nodeCount)
  diagnosis.witness.edges.forEach((w, i) => {
    const e = solution.edges[i]
    expect(w.kind).toBe(e.kind)
    expect(w.id).toBe(e.id)
    expect(w.capacity).toBe(e.capacity)
    expect(Number.isSafeInteger(w.flow)).toBe(true)
    expect(w.flow).toBeGreaterThanOrEqual(0)
    expect(w.flow).toBeLessThanOrEqual(w.capacity)
    balance[e.from] -= w.flow
    balance[e.to] += w.flow
  })
  for (let v = 0; v < solution.nodeCount - 2; v++) expect(balance[v]).toBe(0)
  expect(-balance[solution.superSource] + 0).toBe(V)
  expect(balance[solution.superSink] + 0).toBe(V)

  // 逐点实际供水 = 见证中需求边流量，且缺口口径一致。
  let deliveredSum = 0
  net.sinks.forEach((k, sinkIndex) => {
    const w = diagnosis.witness.edges[solution.sinkEdgeIndex[sinkIndex]]
    expect(w.id).toBe(k.node)
    const a = diagnosis.allocations[sinkIndex]
    expect(a.sinkNode).toBe(k.node)
    expect(a.delivered).toBe(w.flow)
    if (a.minimum === null) {
      expect(a.gap).toBe(0)
    } else {
      expect(a.gap).toBe(Math.max(0, a.minimum - a.delivered))
    }
    deliveredSum += w.flow
  })
  expect(deliveredSum).toBe(V)
  expect(diagnosis.totalGap).toBe(
    diagnosis.allocations.reduce((g, a) => g + a.gap, 0),
  )

  // 复通的候选管段出现在见证中；其余仍停用的管段不在见证中。
  expect(
    diagnosis.witness.edges.some(
      (w) => w.kind === 'arc' && w.id === candidate.arcId,
    ),
  ).toBe(true)
  diagnosis.witness.edges.forEach((w) => {
    if (w.kind === 'arc') expect(restoredDisabled.has(w.id)).toBe(false)
  })
}

/**
 * 锁定场景网络：
 *  - q2 复通：缺口 3 → 0（供水量 5 → 10）；
 *  - t 复通：供水量 5 → 12，缺口不变（d3 无承诺）；
 *  - y-nop / z-nop 复通：完全不接管网，无任何变化。
 */
function lockedNet(): Network {
  return {
    nodes: [
      { id: 's' },
      { id: 'm' },
      { id: 'u' },
      { id: 'd1' },
      { id: 'd2' },
      { id: 'd3' },
      { id: 'x' },
      { id: 'y' },
      { id: 'x2' },
      { id: 'y2' },
    ],
    arcs: [
      { id: 'p', from: 's', to: 'm', capacity: 10 },
      { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
      { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
      { id: 't', from: 's', to: 'u', capacity: 7 },
      { id: 'u3', from: 'u', to: 'd3', capacity: 7 },
      { id: 'z-nop', from: 'x', to: 'y', capacity: 3 },
      { id: 'y-nop', from: 'x2', to: 'y2', capacity: 4 },
    ],
    sources: [{ node: 's', capacity: 100 }],
    sinks: [
      { node: 'd1', capacity: 5 },
      { node: 'd2', capacity: 5 },
      { node: 'd3', capacity: 7 },
    ],
  }
}

const LOCKED_DISABLED = ['q2', 't', 'z-nop', 'y-nop']
const LOCKED_ENTRIES = [
  { node: 'd1', minimum: 3 },
  { node: 'd2', minimum: 3 },
]

describe('单管复通建议：穷举预言机（小网络随机断管）', () => {
  it('候选最大供水量、总缺口、排序、差额不变量与见证守恒均与枚举一致', () => {
    const rng = mulberry32(20261005)
    const ROUNDS = 120
    let candidateCount = 0
    for (let round = 0; round < ROUNDS; round++) {
      const net = smallIntervalNetwork(rng)
      const disabled = new Set<string>()
      net.arcs.forEach((a) => {
        if (rng() < 0.45) disabled.add(a.id)
      })
      // 随机承诺：留空 / 0..容量。
      const mins: (number | null)[] = net.sinks.map((k) => {
        if (rng() < 0.3) return null
        return Math.floor(rng() * (k.capacity + 1))
      })
      const entries = net.sinks.flatMap((k, i) =>
        mins[i] === null ? [] : [{ node: k.node, minimum: mins[i] as number }],
      )

      const result = generateRestoreSuggestion(net, disabled, entries)
      expect(result.ok, `round=${round}`).toBe(true)
      if (!result.ok) continue
      const ev = result.session.evaluation
      expect(result.session.fingerprint).toBe(
        restoreFingerprint(net, disabled, entries),
      )

      // 差额基准：当前方案的枚举最大总量与最小总缺口。
      const currentAll = enumerateFeasibleFlows(net, disabled)
      const V = Math.max(...currentAll.map((p) => p.total))
      expect(ev.currentValue).toBe(V)
      expect(ev.currentGap).toBe(oracleMinGap(currentAll, V, mins))

      // 候选集合 = 停用管段 id 升序前 20 条（小网络不触发截断）。
      const sortedDisabled = [...disabled].sort()
      expect(ev.disabledCount).toBe(sortedDisabled.length)
      expect(ev.evaluated).toBe(
        Math.min(RESTORE_CANDIDATE_LIMIT, sortedDisabled.length),
      )
      expect(ev.truncated).toBe(sortedDisabled.length > RESTORE_CANDIDATE_LIMIT)
      expect(ev.candidates.length).toBe(ev.evaluated)
      expect(ev.candidates.map((c) => c.arcId).sort()).toEqual(
        sortedDisabled.slice(0, RESTORE_CANDIDATE_LIMIT),
      )
      expect(ev.committed).toBe(entries.length)

      // 排序：总缺口升序 → 总供水量降序 → 管段 id 升序（id 唯一，严格小于）。
      for (let i = 1; i < ev.candidates.length; i++) {
        const a = ev.candidates[i - 1]
        const b = ev.candidates[i]
        const cmp =
          a.totalGap - b.totalGap ||
          b.maxSupply - a.maxSupply ||
          (a.arcId < b.arcId ? -1 : 1)
        expect(cmp).toBeLessThan(0)
      }

      for (const c of ev.candidates) {
        candidateCount++
        const restored = new Set(disabled)
        restored.delete(c.arcId)
        const all = enumerateFeasibleFlows(net, restored)
        const Vc = Math.max(...all.map((p) => p.total))

        // 候选自身的最大总供水量与最小总缺口 = 枚举预言机。
        expect(c.maxSupply).toBe(Vc)
        expect(c.totalGap).toBe(oracleMinGap(all, Vc, mins))
        // 差额口径与单调性：复通不降供水量、不增缺口。
        expect(c.supplyDelta).toBe(c.maxSupply - ev.currentValue)
        expect(c.gapDelta).toBe(c.totalGap - ev.currentGap)
        expect(c.supplyDelta).toBeGreaterThanOrEqual(0)
        expect(c.gapDelta).toBeLessThanOrEqual(0)
        expect(c.improves).toBe(
          c.gapDelta < 0 || (c.gapDelta === 0 && c.supplyDelta > 0),
        )
        // 联合承诺数据流：可行 ⇔ 总缺口 0。
        expect(c.jointFeasible).toBe(c.totalGap === 0)
        // 见证：复通后新总量下的可行最大流（容量/守恒/逐点一致）。
        expect(c.diagnosis.committed).toBe(entries.length)
        expect(c.diagnosis.totalGap).toBe(c.totalGap)
        expectCandidateWitness(net, restored, c)
      }

      // 汇总标记与推荐。
      expect(ev.anyImprovement).toBe(ev.candidates.some((c) => c.improves))
      expect(ev.recommended).toBe(
        ev.anyImprovement && ev.candidates.length > 0
          ? ev.candidates[0].arcId
          : null,
      )
    }
    expect(candidateCount).toBeGreaterThan(150)
  })
})

describe('单管复通建议：锁定场景', () => {
  it('排序锁定：缺口改善 > 仅供水提升 > 无变化（id 升序），差额逐项锁定', () => {
    const net = lockedNet()
    const disabled = new Set(LOCKED_DISABLED)
    const result = generateRestoreSuggestion(net, disabled, LOCKED_ENTRIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ev = result.session.evaluation

    expect(ev.currentValue).toBe(5)
    expect(ev.currentGap).toBe(3)
    expect(ev.disabledCount).toBe(4)
    expect(ev.evaluated).toBe(4)
    expect(ev.truncated).toBe(false)
    expect(ev.committed).toBe(2)
    expect(ev.candidates.map((c) => c.arcId)).toEqual([
      'q2',
      't',
      'y-nop',
      'z-nop',
    ])
    expect(ev.recommended).toBe('q2')
    expect(ev.anyImprovement).toBe(true)

    const byId = new Map(ev.candidates.map((c) => [c.arcId, c]))
    expect(byId.get('q2')).toMatchObject({
      maxSupply: 10,
      totalGap: 0,
      supplyDelta: 5,
      gapDelta: -3,
      jointFeasible: true,
      improves: true,
    })
    expect(byId.get('t')).toMatchObject({
      maxSupply: 12,
      totalGap: 3,
      supplyDelta: 7,
      gapDelta: 0,
      jointFeasible: false,
      improves: true,
    })
    for (const id of ['y-nop', 'z-nop']) {
      expect(byId.get(id)).toMatchObject({
        maxSupply: 5,
        totalGap: 3,
        supplyDelta: 0,
        gapDelta: 0,
        jointFeasible: false,
        improves: false,
      })
    }
    // 复通后最大流改变的候选，其见证总量 = 复通后最大供水量。
    for (const c of ev.candidates) {
      expect(c.diagnosis.witness.total).toBe(c.maxSupply)
      expectCandidateWitness(
        net,
        new Set(LOCKED_DISABLED.filter((d) => d !== c.arcId)),
        c,
      )
    }

    // 确定性：同输入重复生成逐项相等。
    const again = generateRestoreSuggestion(net, disabled, LOCKED_ENTRIES)
    expect(again).toEqual(result)
  })

  it('无承诺：缺口恒 0，按复通后供水量降序、管段 id 升序排列', () => {
    const net = lockedNet()
    const disabled = new Set(LOCKED_DISABLED)
    const result = generateRestoreSuggestion(net, disabled, [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ev = result.session.evaluation
    expect(ev.committed).toBe(0)
    expect(ev.currentGap).toBe(0)
    expect(ev.candidates.map((c) => c.arcId)).toEqual([
      't',
      'q2',
      'y-nop',
      'z-nop',
    ])
    ev.candidates.forEach((c) => {
      expect(c.totalGap).toBe(0)
      expect(c.gapDelta).toBe(0)
      expect(c.jointFeasible).toBe(true)
    })
    expect(ev.recommended).toBe('t')
  })

  it('候选无改善：全部候选均无变化时推荐为 null', () => {
    const net = lockedNet()
    const disabled = new Set(['z-nop', 'y-nop'])
    const result = generateRestoreSuggestion(net, disabled, LOCKED_ENTRIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ev = result.session.evaluation
    expect(ev.candidates.map((c) => c.arcId)).toEqual(['y-nop', 'z-nop'])
    expect(ev.anyImprovement).toBe(false)
    expect(ev.recommended).toBeNull()
    ev.candidates.forEach((c) => {
      expect(c.improves).toBe(false)
      expect(c.supplyDelta).toBe(0)
      expect(c.gapDelta).toBe(0)
    })
  })

  it('无停管：候选为空，各计数与推荐均为明确空结果', () => {
    const net = lockedNet()
    const result = generateRestoreSuggestion(net, new Set(), LOCKED_ENTRIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ev = result.session.evaluation
    expect(ev.disabledCount).toBe(0)
    expect(ev.evaluated).toBe(0)
    expect(ev.truncated).toBe(false)
    expect(ev.candidates).toEqual([])
    expect(ev.anyImprovement).toBe(false)
    expect(ev.recommended).toBeNull()
    // 基准仍按当前（空方案）网络核算：d1/d2 各 5、d3 为 7，承诺全部满足。
    expect(ev.currentValue).toBe(17)
    expect(ev.currentGap).toBe(0)
  })

  it('候选上限：25 条停用管段只评估 id 升序前 20 条', () => {
    const nodes = [{ id: 's' }, { id: 'd' }]
    const arcs = [{ id: 'main', from: 's', to: 'd', capacity: 5 }]
    for (let i = 0; i < 25; i++) {
      nodes.push({ id: `x${String(i).padStart(2, '0')}` }, { id: `y${String(i).padStart(2, '0')}` })
      arcs.push({
        id: `x${String(i).padStart(2, '0')}`,
        from: `x${String(i).padStart(2, '0')}`,
        to: `y${String(i).padStart(2, '0')}`,
        capacity: 1,
      })
    }
    const net: Network = {
      nodes,
      arcs,
      sources: [{ node: 's', capacity: 5 }],
      sinks: [{ node: 'd', capacity: 5 }],
    }
    const disabled = new Set(arcs.filter((a) => a.id !== 'main').map((a) => a.id))
    expect(disabled.size).toBe(25)
    const result = generateRestoreSuggestion(net, disabled, [
      { node: 'd', minimum: 5 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ev = result.session.evaluation
    expect(ev.disabledCount).toBe(25)
    expect(ev.evaluated).toBe(RESTORE_CANDIDATE_LIMIT)
    expect(ev.truncated).toBe(true)
    const expected = [...disabled].sort().slice(0, RESTORE_CANDIDATE_LIMIT)
    expect(ev.candidates.map((c) => c.arcId)).toEqual(expected)
    // 全部被截断场景外的候选都是无变化项。
    ev.candidates.forEach((c) => {
      expect(c.maxSupply).toBe(5)
      expect(c.totalGap).toBe(0)
      expect(c.improves).toBe(false)
    })
    expect(ev.anyImprovement).toBe(false)
    expect(ev.recommended).toBeNull()
  })
})

describe('单管复通建议：确认与过期', () => {
  const setup = () => {
    const net = lockedNet()
    const disabled = new Set(['q2', 't'])
    const entries = LOCKED_ENTRIES
    const gen = generateRestoreSuggestion(net, disabled, entries)
    expect(gen.ok).toBe(true)
    if (!gen.ok) throw new Error('unreachable')
    return { net, disabled, entries, session: gen.session }
  }

  it('输入未变：确认成功，返回移除该管段后的新停用集合，入参不被改写', () => {
    const { net, disabled, entries, session } = setup()
    const result = confirmRestoreSuggestion(session, net, disabled, entries, 'q2')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arcId).toBe('q2')
    expect(result.disabled).toEqual(['t'])
    // 入参停用集合不被改写（新旧集合互不影响）。
    expect([...disabled].sort()).toEqual(['q2', 't'])
  })

  it('停用集合变化后确认被拒绝：过期建议不得覆盖现场新操作', () => {
    const { net, entries, session } = setup()
    // 现场新操作：又停用了一条管段。
    const newer = new Set(['q2', 't', 'q1'])
    const result = confirmRestoreSuggestion(session, net, newer, entries, 'q2')
    expect(result.ok).toBe(false)
    expect([...newer].sort()).toEqual(['q1', 'q2', 't'])
    // 现场新操作：恢复了一条管段（候选已不在停用集合中）。
    const restored = new Set(['t'])
    const r2 = confirmRestoreSuggestion(session, net, restored, entries, 'q2')
    expect(r2.ok).toBe(false)
    expect([...restored]).toEqual(['t'])
  })

  it('承诺变化后确认被拒绝', () => {
    const { net, disabled, session } = setup()
    const changed = [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 2 },
    ]
    const result = confirmRestoreSuggestion(session, net, disabled, changed, 'q2')
    expect(result.ok).toBe(false)
    const cleared = confirmRestoreSuggestion(session, net, disabled, [], 'q2')
    expect(cleared.ok).toBe(false)
  })

  it('模型变化后确认被拒绝', () => {
    const { net, disabled, entries, session } = setup()
    const changed: Network = {
      ...net,
      arcs: net.arcs.map((a) =>
        a.id === 'p' ? { ...a, capacity: 6 } : a,
      ),
    }
    const result = confirmRestoreSuggestion(session, changed, disabled, entries, 'q2')
    expect(result.ok).toBe(false)
  })

  it('确认成功一次后原会话立即过期，不得二次应用', () => {
    const { net, disabled, entries, session } = setup()
    const first = confirmRestoreSuggestion(session, net, disabled, entries, 'q2')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // 应用后的现场停用集合：会话指纹已不匹配。
    const applied = new Set(first.disabled)
    const second = confirmRestoreSuggestion(session, net, applied, entries, 't')
    expect(second.ok).toBe(false)
    expect([...applied]).toEqual(['t'])
  })

  it('候选之外的管段（含未评估的截断候选与陌生 id）确认被拒绝', () => {
    const { net, disabled, entries, session } = setup()
    // 'p' 不在停用集合中，自然不是候选。
    const r1 = confirmRestoreSuggestion(session, net, disabled, entries, 'p')
    expect(r1.ok).toBe(false)
    const r2 = confirmRestoreSuggestion(session, net, disabled, entries, 'ghost')
    expect(r2.ok).toBe(false)
    expect([...disabled].sort()).toEqual(['q2', 't'])
  })

  it('截断候选之外：第 21 条起的停用管段不在建议中，确认被拒绝', () => {
    const nodes = [{ id: 's' }, { id: 'd' }]
    const arcs = [{ id: 'main', from: 's', to: 'd', capacity: 5 }]
    for (let i = 0; i < 21; i++) {
      const id = `x${String(i).padStart(2, '0')}`
      nodes.push({ id: `${id}a` }, { id: `${id}b` })
      arcs.push({ id, from: `${id}a`, to: `${id}b`, capacity: 1 })
    }
    const net: Network = {
      nodes,
      arcs,
      sources: [{ node: 's', capacity: 5 }],
      sinks: [{ node: 'd', capacity: 5 }],
    }
    const disabled = new Set(arcs.filter((a) => a.id !== 'main').map((a) => a.id))
    const gen = generateRestoreSuggestion(net, disabled, [])
    expect(gen.ok).toBe(true)
    if (!gen.ok) return
    const last = [...disabled].sort()[20]
    expect(gen.session.evaluation.candidates.some((c) => c.arcId === last)).toBe(
      false,
    )
    const result = confirmRestoreSuggestion(gen.session, net, disabled, [], last)
    expect(result.ok).toBe(false)
  })
})

describe('单管复通建议：失败隔离与互不污染', () => {
  it('无效承诺：生成失败且不抛出、不改写输入', () => {
    const net = lockedNet()
    const disabled = new Set(['q2', 't'])
    const snapshot = JSON.stringify(net)
    for (const bad of [
      [{ node: 'd1', minimum: 99 }], // 超容量
      [{ node: 'd1', minimum: -1 }], // 负数
      [{ node: 'd1', minimum: 1.5 }], // 小数
      [{ node: 'ghost', minimum: 1 }], // 陌生需求点
    ]) {
      let threw = false
      let result
      try {
        result = generateRestoreSuggestion(net, disabled, bad)
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      expect(result).toMatchObject({ ok: false })
      expect([...disabled].sort()).toEqual(['q2', 't'])
      expect(JSON.stringify(net)).toBe(snapshot)
    }
  })

  it('生成建议不污染当前方案：最大流与缺口诊断在生成前后逐项一致', () => {
    const net = lockedNet()
    const disabled = new Set(LOCKED_DISABLED)
    const entries = LOCKED_ENTRIES

    const before = solvePlan(net, disabled)
    const gapBefore = minimumCommitmentGapByNode(before, entries)
    expect(gapBefore.ok).toBe(true)

    const result = generateRestoreSuggestion(net, disabled, entries)
    expect(result.ok).toBe(true)

    const after = solvePlan(net, disabled)
    const gapAfter = minimumCommitmentGapByNode(after, entries)
    expect(after.analysis).toEqual(before.analysis)
    expect(Array.from(after.flow)).toEqual(Array.from(before.flow))
    expect(Array.from(after.residual)).toEqual(Array.from(before.residual))
    expect(gapAfter).toEqual(gapBefore)
    // 输入未被改写。
    expect([...disabled].sort()).toEqual([...LOCKED_DISABLED].sort())
    expect(entries).toEqual(LOCKED_ENTRIES)
  })

  it('指纹：承诺填写顺序无关；模型/停用/承诺任一变化即不同', () => {
    const net = lockedNet()
    const disabled = new Set(['q2', 't'])
    const e1 = LOCKED_ENTRIES
    const e2 = [LOCKED_ENTRIES[1], LOCKED_ENTRIES[0]]
    expect(restoreFingerprint(net, disabled, e1)).toBe(
      restoreFingerprint(net, disabled, e2),
    )
    const base = restoreFingerprint(net, disabled, e1)
    expect(restoreFingerprint(net, disabled, [])).not.toBe(base)
    expect(
      restoreFingerprint(net, disabled, [{ node: 'd1', minimum: 3 }]),
    ).not.toBe(base)
    expect(restoreFingerprint(net, new Set(['q2']), e1)).not.toBe(base)
    expect(restoreFingerprint(net, new Set(['q2', 't', 'q1']), e1)).not.toBe(base)
    const changed: Network = {
      ...net,
      sinks: net.sinks.map((k) =>
        k.node === 'd3' ? { ...k, capacity: 8 } : k,
      ),
    }
    expect(restoreFingerprint(changed, disabled, e1)).not.toBe(base)
  })
})
