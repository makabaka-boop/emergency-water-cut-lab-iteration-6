import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import { GapDiagnosis, minimumCommitmentGapByNode } from '../src/core/gap'
import {
  adviseRestoration,
  compareRestoreCandidates,
  confirmRestoration,
  MAX_RESTORE_CANDIDATES,
  RestoreAdviceSolved,
  RestoreCommitment,
} from '../src/core/restore'
import { Network } from '../src/core/types'
import {
  enumerateFeasibleFlows,
  FeasiblePoint,
  mulberry32,
  smallIntervalNetwork,
} from './helpers'

/**
 * 独立预言机：枚举小网络全部可行流，对「恢复某一条停用管段」的方案
 * 直接求 最大总供水量 与 该总量下的最小总缺口（与生产代码无关）。
 */
function oracleMaxSupply(all: FeasiblePoint[]): number {
  let best = 0
  for (const p of all) if (p.total > best) best = p.total
  return best
}

function oracleMinGap(
  all: FeasiblePoint[],
  V: number,
  mins: (number | null)[],
): number {
  let best = Infinity
  for (const p of all) {
    if (p.total !== V) continue
    let gap = 0
    mins.forEach((m, k) => {
      if (m !== null) gap += m - Math.min(p.sinkY[k], m)
    })
    if (gap < best) best = gap
  }
  return best
}

/** 独立校验候选见证：容量、原节点守恒、超级源汇平衡、逐点水量与缺口。 */
function expectValidRestoreWitness(
  net: Network,
  restoredDisabled: ReadonlySet<string>,
  diagnosis: GapDiagnosis,
): void {
  const solution = solvePlan(net, restoredDisabled)
  const n = net.nodes.length
  const V = solution.analysis.value

  expect(diagnosis.total).toBe(V)
  expect(diagnosis.witness.total).toBe(V)
  expect(diagnosis.witness.edges.length).toBe(solution.edges.length)

  const balance = new Float64Array(n + 2)
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
  for (let v = 0; v < n; v++) expect(balance[v]).toBe(0)
  expect(-balance[solution.superSource] + 0).toBe(V)
  expect(balance[solution.superSink] + 0).toBe(V)

  // 逐点实际供水 = 见证中需求边流量；总缺口 = 逐点缺口之和。
  let totalGap = 0
  net.sinks.forEach((k, sinkIndex) => {
    const w = diagnosis.witness.edges[solution.sinkEdgeIndex[sinkIndex]]
    expect(w.id).toBe(k.node)
    const alloc = diagnosis.allocations[sinkIndex]
    expect(alloc.sinkNode).toBe(k.node)
    expect(alloc.delivered).toBe(w.flow)
    expect(alloc.gap).toBe(
      alloc.minimum === null ? 0 : Math.max(0, alloc.minimum - alloc.delivered),
    )
    totalGap += alloc.gap
  })
  expect(diagnosis.totalGap).toBe(totalGap)
}

/** 从随机承诺（含留空）构造条目；mins 按 network.sinks 顺序（null=留空）。 */
function randomCommitments(
  net: Network,
  rng: () => number,
): { mins: (number | null)[]; filled: RestoreCommitment[] } {
  const mins: (number | null)[] = []
  const filled: RestoreCommitment[] = []
  net.sinks.forEach((k) => {
    if (rng() < 0.35) {
      mins.push(null)
      return
    }
    const m = Math.floor(rng() * (k.capacity + 1))
    mins.push(m)
    filled.push({ node: k.node, minimum: m })
  })
  return { mins, filled }
}

describe('单管复通建议：穷举预言机（小网络逐候选核对）', () => {
  it('候选最大供水量/总缺口与枚举一致，排序合规，见证守恒，差额方向不变', () => {
    const rng = mulberry32(20261005)
    const ROUNDS = 300
    let evaluated = 0
    for (let round = 0; round < ROUNDS; round++) {
      const net = smallIntervalNetwork(rng)
      // 保证多数方案至少停用一条管段。
      const disabled = new Set<string>()
      net.arcs.forEach((a) => {
        if (rng() < 0.45) disabled.add(a.id)
      })
      if (disabled.size === 0 && net.arcs.length > 0) {
        disabled.add(net.arcs[Math.floor(rng() * net.arcs.length)].id)
      }
      const { mins, filled } = randomCommitments(net, rng)

      const result = adviseRestoration(net, disabled, filled)
      if (disabled.size === 0) {
        expect(result).toEqual({ ok: true, status: 'no-disabled' })
        continue
      }
      if (filled.length === 0) {
        expect(result).toEqual({ ok: true, status: 'no-commitments' })
        continue
      }
      expect(result.ok, `round=${round}`).toBe(true)
      if (!result.ok || result.status === 'no-disabled') continue
      if (!('candidates' in result)) throw new Error('expected solved advice')

      // 当前方案基准与枚举一致。
      const allCurrent = enumerateFeasibleFlows(net, disabled)
      const V0 = oracleMaxSupply(allCurrent)
      const gap0 = oracleMinGap(allCurrent, V0, mins)
      expect(result.current.maxSupply).toBe(V0)
      expect(result.current.totalGap).toBe(gap0)
      expect(result.disabledTotal).toBe(disabled.size)

      // 候选集合 = 停用 id UTF-16 升序前 20 条（小网络即全部停用管段）。
      const picked = [...disabled].sort().slice(0, MAX_RESTORE_CANDIDATES)
      expect(result.evaluated).toBe(picked.length)
      expect(new Set(result.candidates.map((c) => c.arcId))).toEqual(
        new Set(picked),
      )

      for (const c of result.candidates) {
        evaluated++
        const restored = new Set(disabled)
        restored.delete(c.arcId)
        const all = enumerateFeasibleFlows(net, restored)
        const V = oracleMaxSupply(all)
        // 候选自身的最大总供水量与最小总缺口都和枚举预言机一致。
        expect(c.maxSupply).toBe(V)
        expect(c.totalGap).toBe(oracleMinGap(all, V, mins))
        // 差额相对当前方案，且方向满足单调性（供水不减、缺口不增）。
        expect(c.supplyDelta).toBe(c.maxSupply - V0)
        expect(c.gapDelta).toBe(c.totalGap - gap0)
        expect(c.supplyDelta).toBeGreaterThanOrEqual(0)
        expect(c.gapDelta).toBeLessThanOrEqual(0)
        // 见证总量 = 候选最大供水量，且容量/守恒/逐点缺口独立校验通过。
        expect(c.diagnosis.total).toBe(c.maxSupply)
        expect(c.diagnosis.totalGap).toBe(c.totalGap)
        expectValidRestoreWitness(net, restored, c.diagnosis)
      }

      // 排序：总缺口↑ → 供水量↓ → 管段 id（相邻对满足严格全序）。
      for (let i = 0; i + 1 < result.candidates.length; i++) {
        const a = result.candidates[i]
        const b = result.candidates[i + 1]
        expect(compareRestoreCandidates(a, b)).toBeLessThan(0)
        expect(compareRestoreCandidates(b, a)).toBeGreaterThan(0)
      }
      const bestGap = Math.min(...result.candidates.map((c) => c.totalGap))
      expect(result.status).toBe(bestGap < gap0 ? 'ok' : 'no-improvement')
    }
    expect(evaluated).toBeGreaterThan(200)
  })

  it('同一输入重复生成逐项相等（确定性）', () => {
    const rng = mulberry32(777)
    for (let round = 0; round < 40; round++) {
      const net = smallIntervalNetwork(rng)
      const disabled = new Set<string>()
      net.arcs.forEach((a) => {
        if (rng() < 0.4) disabled.add(a.id)
      })
      if (disabled.size === 0 && net.arcs.length > 0) disabled.add(net.arcs[0].id)
      const { filled } = randomCommitments(net, rng)
      const a = adviseRestoration(net, disabled, filled)
      const b = adviseRestoration(net, disabled, filled)
      expect(a).toEqual(b)
    }
  })
})

describe('单管复通建议：明确结果（无停管 / 无承诺 / 无改善 / 最大流改变）', () => {
  /** 共享瓶颈 + 一条通往未承诺点的支路。 */
  function branchNet(): Network {
    return {
      nodes: [
        { id: 's' },
        { id: 'm' },
        { id: 'd1' },
        { id: 'd2' },
        { id: 'd3' },
      ],
      arcs: [
        { id: 'p', from: 's', to: 'm', capacity: 5 },
        { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
        { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
        { id: 'r', from: 's', to: 'd3', capacity: 5 },
      ],
      sources: [{ node: 's', capacity: 100 }],
      sinks: [
        { node: 'd1', capacity: 5 },
        { node: 'd2', capacity: 5 },
        { node: 'd3', capacity: 5 },
      ],
    }
  }

  it('无停用管段：no-disabled，不评估任何候选', () => {
    const net = branchNet()
    const result = adviseRestoration(net, new Set(), [
      { node: 'd1', minimum: 3 },
    ])
    expect(result).toEqual({ ok: true, status: 'no-disabled' })
  })

  it('无有效承诺：no-commitments（有停用管段也不评估）', () => {
    const net = branchNet()
    const result = adviseRestoration(net, new Set(['r']), [])
    expect(result).toEqual({ ok: true, status: 'no-commitments' })
  })

  it('候选无改善：复通只提升供水量、不能缩小缺口时明确报 no-improvement', () => {
    const net = branchNet()
    const commitments = [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 3 },
    ]
    const result = adviseRestoration(net, new Set(['r']), commitments)
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.status).toBe('no-improvement')
    expect(result.current).toEqual({ maxSupply: 5, totalGap: 1 })
    expect(result.candidates).toHaveLength(1)
    const c = result.candidates[0]
    // 复通 r：最大供水量 5→10（最大流改变的明确结果），缺口不变。
    expect(c.arcId).toBe('r')
    expect(c.maxSupply).toBe(10)
    expect(c.totalGap).toBe(1)
    expect(c.supplyDelta).toBe(5)
    expect(c.gapDelta).toBe(0)
    expectValidRestoreWitness(net, new Set(), c.diagnosis)
  })

  it('复通瓶颈管段：缺口缩小且供水量提升，差额符号正确', () => {
    const net = branchNet()
    const commitments = [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 3 },
    ]
    // 停用主干 p 与支路 r：当前 V=0、缺口 6。
    const result = adviseRestoration(net, new Set(['p', 'r']), commitments)
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.status).toBe('ok')
    expect(result.current).toEqual({ maxSupply: 0, totalGap: 6 })
    // p 排第一（缺口 6→1），r 排第二（缺口不变、供水 0→5）。
    expect(result.candidates.map((c) => c.arcId)).toEqual(['p', 'r'])
    const [p, r] = result.candidates
    expect([p.maxSupply, p.totalGap, p.supplyDelta, p.gapDelta]).toEqual([
      5, 1, 5, -5,
    ])
    expect([r.maxSupply, r.totalGap, r.supplyDelta, r.gapDelta]).toEqual([
      5, 6, 5, 0,
    ])
  })
})

describe('单管复通建议：排序稳定（缺口 → 供水量 → 管段 id）', () => {
  function tieNet(): Network {
    return {
      nodes: [
        { id: 's' },
        { id: 'm' },
        { id: 'd1' },
        { id: 'd2' },
        { id: 'd3' },
      ],
      arcs: [
        { id: 'p', from: 's', to: 'm', capacity: 5 },
        { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
        { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
        { id: 'x1', from: 's', to: 'd3', capacity: 8 },
        { id: 'x2', from: 's', to: 'd3', capacity: 3 },
      ],
      sources: [{ node: 's', capacity: 100 }],
      sinks: [
        { node: 'd1', capacity: 5 },
        { node: 'd2', capacity: 5 },
        { node: 'd3', capacity: 100 },
      ],
    }
  }
  const commitments = [
    { node: 'd1', minimum: 3 },
    { node: 'd2', minimum: 3 },
  ]

  it('缺口相同 → 复通后供水量大者在前', () => {
    const result = adviseRestoration(tieNet(), new Set(['x1', 'x2']), commitments)
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.status).toBe('no-improvement')
    expect(result.candidates.map((c) => c.arcId)).toEqual(['x1', 'x2'])
    expect(result.candidates.map((c) => c.maxSupply)).toEqual([13, 8])
    expect(result.candidates.every((c) => c.totalGap === 1)).toBe(true)
  })

  it('缺口与供水量都相同 → 管段 id UTF-16 升序', () => {
    const net = tieNet()
    net.arcs = net.arcs.filter((a) => !a.id.startsWith('x'))
    net.arcs.push(
      { id: 'r-b', from: 's', to: 'd3', capacity: 5 },
      { id: 'r-a', from: 's', to: 'd3', capacity: 5 },
    )
    const result = adviseRestoration(net, new Set(['r-a', 'r-b']), commitments)
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.candidates.map((c) => c.arcId)).toEqual(['r-a', 'r-b'])
    expect(result.candidates.map((c) => c.maxSupply)).toEqual([10, 10])
  })

  it('总缺口是第一关键字：能缩小缺口的候选即使 id 更大也排最前', () => {
    const net: Network = {
      nodes: [
        { id: 's' },
        { id: 'm' },
        { id: 'd1' },
        { id: 'd2' },
        { id: 'd3' },
      ],
      arcs: [
        { id: 'z-main', from: 's', to: 'm', capacity: 5 },
        { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
        { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
        { id: 'a-dead', from: 's', to: 'd3', capacity: 5 },
      ],
      sources: [{ node: 's', capacity: 100 }],
      sinks: [
        { node: 'd1', capacity: 5 },
        { node: 'd2', capacity: 5 },
        { node: 'd3', capacity: 5 },
      ],
    }
    const result = adviseRestoration(
      net,
      new Set(['z-main', 'a-dead']),
      commitments,
    )
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.status).toBe('ok')
    expect(result.candidates.map((c) => c.arcId)).toEqual(['z-main', 'a-dead'])
    expect(result.candidates[0].totalGap).toBe(1)
    expect(result.candidates[1].totalGap).toBe(6)
  })

  it('候选上限：停用 25 条时只评估 id 升序前 20 条', () => {
    const arcs: Network['arcs'] = [
      { id: 'main', from: 's', to: 't', capacity: 4 },
    ]
    for (let i = 0; i < 25; i++) {
      arcs.push({ id: `z${i}`, from: 's', to: 's', capacity: 1 }) // 自环，不影响流量
    }
    const net: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs,
      sources: [{ node: 's', capacity: 4 }],
      sinks: [{ node: 't', capacity: 4 }],
    }
    const disabled = new Set(arcs.filter((a) => a.id !== 'main').map((a) => a.id))
    const result = adviseRestoration(net, disabled, [
      { node: 't', minimum: 4 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.disabledTotal).toBe(25)
    expect(result.evaluated).toBe(MAX_RESTORE_CANDIDATES)
    expect(result.candidates).toHaveLength(MAX_RESTORE_CANDIDATES)
    const expected = [...disabled].sort().slice(0, MAX_RESTORE_CANDIDATES)
    expect(new Set(result.candidates.map((c) => c.arcId))).toEqual(
      new Set(expected),
    )
    // 自环复通不改变最大流与缺口：全部无改善。
    expect(result.status).toBe('no-improvement')
    expect(
      result.candidates.every(
        (c) => c.maxSupply === 4 && c.totalGap === 0 && c.supplyDelta === 0,
      ),
    ).toBe(true)
  })
})

describe('单管复通确认：应用与过期保护', () => {
  function parallelNet(): Network {
    return {
      nodes: [{ id: 's' }, { id: 'd' }],
      arcs: [
        { id: 'r1', from: 's', to: 'd', capacity: 3 },
        { id: 'r2', from: 's', to: 'd', capacity: 3 },
      ],
      sources: [{ node: 's', capacity: 10 }],
      sinks: [{ node: 'd', capacity: 10 }],
    }
  }
  const commitments = [{ node: 'd', minimum: 6 }]

  function solvedAdvice(): {
    net: Network
    disabled: Set<string>
    advice: RestoreAdviceSolved
  } {
    const net = parallelNet()
    const disabled = new Set(['r2'])
    const result = adviseRestoration(net, disabled, commitments)
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) {
      throw new Error('expected solved advice')
    }
    return { net, disabled, advice: result }
  }

  it('确认成功：返回新停用集合，最大供水量与缺口和独立重算一致', () => {
    const { net, disabled, advice } = solvedAdvice()
    expect(advice.current).toEqual({ maxSupply: 3, totalGap: 3 })
    expect(advice.candidates).toHaveLength(1)
    expect(advice.candidates[0]).toMatchObject({
      arcId: 'r2',
      maxSupply: 6,
      totalGap: 0,
      supplyDelta: 3,
      gapDelta: -3,
    })

    const result = confirmRestoration(net, advice, 'r2', {
      disabled,
      commitments,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.disabled).toEqual([])
    // 复通后最大流改变（3→6）有明确结果，且与独立重算一致。
    expect(result.maxSupply).toBe(6)
    expect(result.maxSupply).toBe(solvePlan(net, new Set()).analysis.value)
    const regap = minimumCommitmentGapByNode(solvePlan(net, new Set()), commitments)
    expect(regap.ok).toBe(true)
    if (regap.ok) expect(result.totalGap).toBe(regap.totalGap)
  })

  it('过期确认：停用集合变化后建议不得覆盖现场新操作', () => {
    const { net, advice } = solvedAdvice()
    // 现场已另行操作：r2 被手动恢复 / 又停用了 r1。
    for (const current of [new Set<string>(), new Set(['r1']), new Set(['r1', 'r2'])]) {
      const result = confirmRestoration(net, advice, 'r2', {
        disabled: current,
        commitments,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('过期')
    }
  })

  it('过期确认：承诺变化后建议失效', () => {
    const { net, disabled, advice } = solvedAdvice()
    const result = confirmRestoration(net, advice, 'r2', {
      disabled,
      commitments: [{ node: 'd', minimum: 5 }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('过期')
  })

  it('过期确认：模型变化（容量/结构）后建议失效', () => {
    const { net, disabled, advice } = solvedAdvice()
    const tweaked: Network = {
      ...net,
      arcs: net.arcs.map((a) =>
        a.id === 'r1' ? { ...a, capacity: a.capacity + 1 } : a,
      ),
    }
    const result = confirmRestoration(tweaked, advice, 'r2', {
      disabled,
      commitments,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('过期')
  })

  it('确认失败的其他情形：未知管段、未停用管段、被篡改的建议', () => {
    const { net, disabled, advice } = solvedAdvice()
    expect(
      confirmRestoration(net, advice, 'ghost', { disabled, commitments }).ok,
    ).toBe(false)
    expect(
      confirmRestoration(net, advice, 'r1', { disabled, commitments }).ok,
    ).toBe(false)
    // 篡改建议中的复通后最大供水量：确认时的最大流核对必须拦下。
    const tampered: RestoreAdviceSolved = {
      ...advice,
      candidates: advice.candidates.map((c) => ({ ...c, maxSupply: c.maxSupply + 1 })),
    }
    const result = confirmRestoration(net, tampered, 'r2', {
      disabled,
      commitments,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('最大供水量')
  })

  it('确认是纯函数：失败或成功都不改写网络、建议与停用集合', () => {
    const { net, disabled, advice } = solvedAdvice()
    const netJson = JSON.stringify(net)
    const adviceJson = JSON.stringify(advice)
    const disabledBefore = [...disabled]

    confirmRestoration(net, advice, 'r2', { disabled, commitments })
    confirmRestoration(net, advice, 'r2', {
      disabled: new Set(),
      commitments,
    })

    expect(JSON.stringify(net)).toBe(netJson)
    expect(JSON.stringify(advice)).toBe(adviceJson)
    expect([...disabled]).toEqual(disabledBefore)
  })

  it('确认成功后原建议立即过期：不能凭旧建议再改动新方案', () => {
    const { net, disabled, advice } = solvedAdvice()
    const first = confirmRestoration(net, advice, 'r2', {
      disabled,
      commitments,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // 用同一份建议再确认一次（当前停用集合已是确认后的新状态）。
    const second = confirmRestoration(net, advice, 'r2', {
      disabled: new Set(first.disabled),
      commitments,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('过期')
  })
})

describe('单管复通建议：失败隔离与输入保护', () => {
  const net: Network = {
    nodes: [{ id: 's' }, { id: 't' }],
    arcs: [
      { id: 'e1', from: 's', to: 't', capacity: 3 },
      { id: 'e2', from: 's', to: 't', capacity: 2 },
    ],
    sources: [{ node: 's', capacity: 5 }],
    sinks: [{ node: 't', capacity: 5 }],
  }

  it('无效承诺（超容量 / 陌生需求点 / 负值）：整体失败且不抛出', () => {
    const disabled = new Set(['e2'])
    for (const bad of [
      [{ node: 't', minimum: 6 }],
      [{ node: 'ghost', minimum: 1 }],
      [{ node: 't', minimum: -1 }],
      [{ node: 't', minimum: 1.5 }],
    ]) {
      let threw = false
      let result
      try {
        result = adviseRestoration(net, disabled, bad)
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      expect(result).toMatchObject({ ok: false })
    }
  })

  it('评估不改写停用集合、承诺与网络（互不污染的副本）', () => {
    const disabled = new Set(['e2'])
    const commitments = [{ node: 't', minimum: 4 }]
    const netJson = JSON.stringify(net)
    adviseRestoration(net, disabled, commitments)
    expect([...disabled]).toEqual(['e2'])
    expect(commitments).toEqual([{ node: 't', minimum: 4 }])
    expect(JSON.stringify(net)).toBe(netJson)
  })

  it('零容量停用管段也是合法候选（复通后最大流不变也有明确结果）', () => {
    const zeroNet: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs: [
        { id: 'e1', from: 's', to: 't', capacity: 3 },
        { id: 'e0', from: 's', to: 't', capacity: 0 },
      ],
      sources: [{ node: 's', capacity: 5 }],
      sinks: [{ node: 't', capacity: 5 }],
    }
    const result = adviseRestoration(zeroNet, new Set(['e0']), [
      { node: 't', minimum: 3 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok || !('candidates' in result)) return
    expect(result.status).toBe('no-improvement')
    expect(result.candidates[0]).toMatchObject({
      arcId: 'e0',
      maxSupply: 3,
      totalGap: 0,
      supplyDelta: 0,
      gapDelta: 0,
    })
  })
})
