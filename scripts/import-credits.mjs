#!/usr/bin/env node
/**
 * 把 EchoMind 本地钱包迁移到账号中心（LoginSuxin）。
 *
 * 先决条件：EchoMind 已切换为账号积分模式（CREDITS_APP_KEY 已设置）并停止写入本地
 * wallet / credit_ledger。否则导入快照会随本地消费继续变化，导致可退积分偏高。
 *
 * 默认 dry-run：只读 D1，按 FIFO 计算每笔付费订单的剩余积分并打印对账表。
 * 加 --apply 才会调用账号中心 /api/admin/credits/import。
 *
 * 用法：
 *   node scripts/import-credits.mjs --remote
 *   node scripts/import-credits.mjs --remote --apply --admin-token <CREDITS_ADMIN_TOKEN>
 *   node scripts/import-credits.mjs --local --apply --admin-token <dev-token> --account-url http://127.0.0.1:8787
 *
 * 对账失败（sum(remaining) !== wallet.balance）默认中止；确认差异原因后可加 --allow-diff。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import process from 'node:process'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

const remote = flag('--remote')
const local = flag('--local')
const apply = flag('--apply')
const allowDiff = flag('--allow-diff')
const db = value('--db', 'echomind-credits')
const appId = value('--app-id') || process.env.CREDITS_APP_ID || 'echomind'
const accountUrl = (value('--account-url') || process.env.CREDITS_API_URL || 'https://account.ljhsu.xin').replace(/\/$/, '')
const adminToken = value('--admin-token') || process.env.CREDITS_ADMIN_TOKEN || ''
const outFile = value('--out')
const chunkSize = 500

if (!remote && !local) {
  console.error('请指定 --remote（生产 D1）或 --local（本地 D1）')
  process.exit(1)
}
if (remote && local) {
  console.error('--remote 与 --local 只能选一个')
  process.exit(1)
}
if (apply && !adminToken) {
  console.error('--apply 需要 --admin-token 或环境变量 CREDITS_ADMIN_TOKEN')
  process.exit(1)
}

function query(sql) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', db, remote ? '--remote' : '--local', '--json', '--command', sql],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || 'wrangler d1 execute 失败')
    process.exit(1)
  }
  const text = result.stdout
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) {
    console.error(`无法解析 wrangler 输出：\n${text}`)
    process.exit(1)
  }
  const parsed = JSON.parse(text.slice(start, end + 1))
  return parsed[0]?.results ?? []
}

console.log(`目标：${remote ? '远程 D1' : '本地 D1'} / ${db}${apply ? '（会写入账号中心）' : '（只读预演）'}`)
console.log(`账号中心：${accountUrl} / appId=${appId}\n`)

const orders = query(
  'select out_trade_no, user_id, credits, amount_cents, paid_at, created_at from pay_order where status = \'paid\' order by user_id, paid_at asc, created_at asc',
)
const usage = query(
  'select user_id, -delta as used, created_at from credit_ledger where reason = \'model_usage\' and delta < 0 order by user_id, created_at asc',
)
const wallets = new Map(query('select user_id, balance from wallet').map(row => [row.user_id, row.balance]))
const ledgerSummary = query('select reason, count(*) as count, sum(delta) as delta from credit_ledger group by reason')

console.log('本地台账：')
for (const row of ledgerSummary) console.log(`  ${row.reason}: ${row.count} 条，合计 ${row.delta}`)
const unexpected = ledgerSummary.filter(row => !['recharge', 'model_usage'].includes(row.reason))
if (unexpected.length > 0) {
  console.warn(`\n注意：存在非 recharge/model_usage 台账（${unexpected.map(row => row.reason).join(', ')}），FIFO 对账可能不准确。`)
}

const users = new Map()
for (const order of orders) {
  if (!users.has(order.user_id)) users.set(order.user_id, { orders: [], used: [] })
  users.get(order.user_id).orders.push({ ...order, paidAt: order.paid_at ?? order.created_at, consumed: 0 })
}
for (const row of usage) {
  if (!users.has(row.user_id)) users.set(row.user_id, { orders: [], used: [] })
  users.get(row.user_id).used.push(row.used)
}

const report = []
let overConsumed = 0
for (const [userId, entry] of users) {
  let index = 0
  let left = entry.orders[0]?.credits ?? 0
  for (const amount of entry.used) {
    let remainingUse = amount
    while (remainingUse > 0) {
      if (index >= entry.orders.length) { overConsumed += remainingUse; break }
      if (left <= 0) { index += 1; left = entry.orders[index]?.credits ?? 0; continue }
      const take = Math.min(remainingUse, left)
      entry.orders[index].consumed += take
      left -= take
      remainingUse -= take
    }
  }
  const creditTotal = entry.orders.reduce((sum, order) => sum + order.credits, 0)
  const consumed = entry.orders.reduce((sum, order) => sum + order.consumed, 0)
  const remaining = entry.orders.reduce((sum, order) => sum + Math.max(0, order.credits - order.consumed), 0)
  const wallet = wallets.get(userId) ?? 0
  report.push({ userId, orders: entry.orders.length, creditTotal, consumed, remaining, wallet, diff: remaining - wallet })
}

const totals = report.reduce((sum, row) => ({
  orders: sum.orders + row.orders,
  creditTotal: sum.creditTotal + row.creditTotal,
  consumed: sum.consumed + row.consumed,
  remaining: sum.remaining + row.remaining,
  wallet: sum.wallet + row.wallet,
}), { orders: 0, creditTotal: 0, consumed: 0, remaining: 0, wallet: 0 })

console.log(`\n账号数 ${report.length}，订单 ${totals.orders} 笔：充值 ${totals.creditTotal}，已消耗 ${totals.consumed}，应导入 ${totals.remaining}，本地钱包 ${totals.wallet}`)
if (overConsumed > 0) console.warn(`消耗超过订单额度：${overConsumed} 积分（数据异常）`)

console.table(report.map(row => ({
  userId: row.userId.slice(0, 12),
  订单: row.orders,
  充值: row.creditTotal,
  已消费: row.consumed,
  应导入: row.remaining,
  本地钱包: row.wallet,
  差额: row.diff,
})))

const mismatched = report.filter(row => row.diff !== 0)
if (mismatched.length > 0) {
  console.warn(`\n${mismatched.length} 个账号对账不一致（应导入 - 本地钱包）。`)
  if (!allowDiff) {
    console.error('已中止，未写入账号中心。确认差异原因后可加 --allow-diff 继续。')
    process.exit(2)
  }
}

const lots = []
for (const [userId, entry] of users) {
  for (const order of entry.orders) {
    lots.push({
      userId,
      orderId: order.out_trade_no,
      credits: order.credits,
      remaining: Math.max(0, order.credits - order.consumed),
      amountCents: order.amount_cents,
      paidAt: order.paidAt,
    })
  }
}

if (apply) {
  console.log(`\n开始导入 ${lots.length} 笔订单…`)
  const result = { imported: 0, duplicates: 0, skipped: [], failed: [], balances: {} }
  for (let index = 0; index < lots.length; index += chunkSize) {
    const chunk = lots.slice(index, index + chunkSize)
    const response = await fetch(`${accountUrl}/api/admin/credits/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-credits-admin': adminToken },
      body: JSON.stringify({ appId, lots: chunk }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      console.error(`导入第 ${index / chunkSize + 1} 批失败：HTTP ${response.status} ${data.error || ''}`)
      process.exit(1)
    }
    result.imported += data.imported ?? 0
    result.duplicates += data.duplicates ?? 0
    result.skipped.push(...(data.skipped ?? []))
    result.failed.push(...(data.failed ?? []))
    Object.assign(result.balances, data.balances ?? {})
    console.log(`  第 ${index / chunkSize + 1} 批：imported=${data.imported ?? 0} duplicates=${data.duplicates ?? 0} skipped=${data.skipped?.length ?? 0} failed=${data.failed?.length ?? 0}`)
  }

  console.log(`\n合计：imported=${result.imported} duplicates=${result.duplicates} skipped=${result.skipped.length} failed=${result.failed.length}`)
  if (result.skipped.length > 0) console.table(result.skipped)
  if (result.failed.length > 0) console.table(result.failed)

  const balanceMismatch = report.filter(row => typeof result.balances[row.userId] === 'number' && result.balances[row.userId] !== row.remaining)
  if (balanceMismatch.length > 0) {
    console.warn('账号中心余额与预期不一致：')
    console.table(balanceMismatch.map(row => ({ userId: row.userId.slice(0, 12), 预期: row.remaining, 实际: result.balances[row.userId] })))
  } else {
    console.log('账号中心余额与预期一致。')
  }

  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ report, totals, result }, null, 2))
    console.log(`报告已写入 ${outFile}`)
  }
  if (result.skipped.length > 0 || result.failed.length > 0) process.exit(1)
} else {
  console.log('\n只读预演完成；确认无误后加 --apply 执行导入。')
}
