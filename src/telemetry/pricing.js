/**
 * 用量 → 钱。把 `ap_usage` 的三种 token 按各模型的单价折成金额。
 *
 * ── 为什么单独一层，而不是写进 usage-store 的聚合 ────────────────────────
 *
 * usage-store 的文件头早就把这条边界写死了："缺的只有单价，而单价不该由这一层猜
 * ……真要接的时候，成本 = Σ(每个模型的 input/output/cacheRead × 该模型当期单价)，
 * 用的就是 summary 已经算出来的那几个数，不必再动这里的聚合。"
 *
 * 这个文件就是那句话的兑现：**聚合一行没改**，这里只在算好的行上挂一个 `cost`。
 * 好处是两件事各自可测 —— 聚合对不对（一份假台账）与折算对不对（一张假价目表）
 * 不会绞在一起，也就不会出现"总数不对，但不知道是加错了还是乘错了"。
 *
 * ── 三条必须写明白的边界 ────────────────────────────────────────────────
 *
 * 1. **没有价格历史。** 折算用的是**此刻**库里那个单价，包括三个月前的那些行。
 *    上游改价（或者管理员改了填错的数）之后，历史账单会跟着变。真要做到
 *    "按当期价结算"，需要的是一张带生效日期的价目表 + 台账落库时就把单价钉进去，
 *    那是另一件事（也更贵：每行多两个字段）。在那之前，这里算出来的是
 *    **「按今天的价，这些用量值多少钱」**，而不是「当时收了多少钱」。
 *
 * 2. **未定价 ≠ 0。** 没填单价的模型（以及已经被删掉、无从查价的那些）算出来的是
 *    `null`，一路传到界面写"未定价"。把它当 0 加进总数，会得到一个看起来很正常、
 *    实际上偏小的合计 —— 而账单上"少了一点"是最不容易被发现的那种错。
 *    所以带未定价模型的行，`cost` 是"已知那部分的金额" + `costPartial: true`。
 *
 * 3. **压缩产生的 token 不在账上。** pi 的上下文压缩会**另外**调一次模型做摘要
 *    （compaction/compaction.js:generateSummary → completeSimple），那次调用的用量
 *    不走 session 的 message_end 事件，因此 extractUsage 收不到、台账里也没有。
 *    也就是说这里算出的成本**比真实上游账单偏低**，差的是每次压缩那一刀。
 *    要补上它得改 pi 或者自己实现压缩，两者都不该为了一个统计数字去做 ——
 *    但这句话必须写在这儿，否则某天有人拿它去和网关账单对数，会以为是漏记。
 *
 * ⚠️ 与 usage-store 同一句话：**这不是账单，是可归因的成本估算。**
 * 对外收钱以模型网关那份为准。
 */

/** 单价的单位：每一百万 token。管理员填的就是上游价目表上那个数，不必换算 */
const PER = 1_000_000

/**
 * 金额保留几位小数。
 *
 * 六位不是精度洁癖：一次几百 token 的对话在每百万 3 元的价上是 0.0009 元，
 * 保留两位的话它就是 0.00 —— 一整页全是 0.00 的表说明不了任何问题。
 * 展示时再按需要收，但接口回的这一份要留得住小数。
 */
const SCALE = 1e6

/** 浮点尾巴收掉。0.1+0.2 那套在累加几千行之后会长出一串 000000004 */
export function round(amount) {
  return Math.round(amount * SCALE) / SCALE
}

/**
 * 一组 token 数 × 一份单价 = 金额。
 *
 * `price` 为空（这条模型没定价）时回 null，**不是 0** —— 见文件头第 2 条。
 */
export function costOf(bucket, price) {
  if (!price) return null
  const input = (Number(bucket?.input) || 0) * (Number(price.input) || 0)
  const output = (Number(bucket?.output) || 0) * (Number(price.output) || 0)
  const cacheRead = (Number(bucket?.cacheRead) || 0) * (Number(price.cacheRead) || 0)
  return round((input + output + cacheRead) / PER)
}

/**
 * 给一批「按模型分的行」算金额，并把未定价的那些点名回来。
 *
 * @param {Array} rows      每行至少有 modelId + input/output/cacheRead
 * @param {Map}   prices    modelId → { input, output, cacheRead }
 * @returns {{cost: number|null, partial: boolean, unpriced: string[]}}
 *   `cost` 是**已定价部分**的合计。一条都算不出来时回 null（而不是 0），
 *   于是界面能把"这些用量不要钱"和"这些用量我们不知道多少钱"分开写。
 */
export function costOfRows(rows, prices) {
  let total = 0
  let known = 0
  const unpriced = new Set()
  for (const row of rows || []) {
    const amount = costOf(row, prices?.get?.(row.modelId))
    if (amount === null) {
      // 一行 0 token 的补零行不算"未定价"：它没有任何成本要算，
      // 点名它只会让界面上凭空多出一串"这些模型没定价"的噪音
      if (row.input || row.output || row.cacheRead) unpriced.add(row.modelId)
      continue
    }
    total += amount
    known += 1
  }
  return {
    cost: known ? round(total) : null,
    partial: known > 0 && unpriced.size > 0,
    unpriced: [...unpriced].sort(),
  }
}

/**
 * 给 summary 的一行（带 children）挂上金额。
 *
 * 两个视图共用它，方向由 `childKey` 决定：
 *   按用户看  行是一个人，children 是他用过的模型 → 每个 child 自己就是一个模型，直接查价
 *   按模型看  行是一个模型，children 是用它的人   → 整行一个价，每个 child 用同一个价
 *
 * 这个不对称是真实的，不是可以抹平的分支：价挂在模型上，而"用户"这一维上
 * 根本不存在单价这种东西。写成一个函数只是让两边的**合计口径**保持一致 ——
 * 行的 cost 永远等于它 children 的 cost 之和（都从同一批 token 数算出来）。
 */
export function priceRow(row, prices, childKey) {
  const children = row[childKey] || []
  if (childKey === 'models') {
    const priced = children.map((child) => ({ ...child, cost: costOf(child, prices?.get?.(child.modelId)) }))
    const rollup = costOfRows(children, prices)
    return { ...row, [childKey]: priced, cost: rollup.cost, costPartial: rollup.partial, unpricedModels: rollup.unpriced }
  }

  // 按模型看：这一行就是一个模型，一个价管到底
  const price = prices?.get?.(row.modelId)
  const priced = children.map((child) => ({ ...child, cost: costOf(child, price) }))
  return {
    ...row,
    [childKey]: priced,
    cost: costOf(row, price),
    costPartial: false,
    unpricedModels: price ? [] : [row.modelId],
  }
}
