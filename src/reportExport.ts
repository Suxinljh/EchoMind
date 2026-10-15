import { overallScore, questionScore, reportStats } from './logic'
import type { Session } from './types'

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

export type ReportAppearance = {
  id: string
  page: string
  surface: string
  subtle: string
  ink: string
  muted: string
  accent: string
  line: string
  font: string
  headingFont: string
  headingWeight: string
  radius: string
  borderWidth: string
  shadow: string
}

export function captureReportAppearance(id: string): ReportAppearance {
  const query = (selector: string) => getComputedStyle(document.querySelector<HTMLElement>(selector) ?? document.body)
  const card = query('.results-page .overall-card')
  const heading = query('.results-page h1')
  return {
    id,
    page: getComputedStyle(document.body).backgroundColor,
    surface: card.backgroundColor,
    subtle: query('.results-page .speech-overview>div').backgroundColor,
    ink: heading.color,
    muted: query('.results-page .overall-copy').color,
    accent: query('.results-page .overall-score').color,
    line: card.borderTopColor,
    font: getComputedStyle(document.body).fontFamily,
    headingFont: heading.fontFamily,
    headingWeight: heading.fontWeight,
    radius: card.borderTopLeftRadius,
    borderWidth: card.borderTopWidth,
    shadow: card.boxShadow,
  }
}

function reportStyle(appearance: ReportAppearance): string {
  return `:root{--page:${appearance.page};--surface:${appearance.surface};--subtle:${appearance.subtle};--ink:${appearance.ink};--muted:${appearance.muted};--accent:${appearance.accent};--line:${appearance.line};--radius:${appearance.radius};--border-width:${appearance.borderWidth};--shadow:${appearance.shadow}}
html{background:var(--page)}
body{font:17px/1.8 ${appearance.font};color:var(--ink);max-width:900px;margin:40px auto;padding:0 24px}
h1,h2,h3{font-family:${appearance.headingFont}}
h1{font-size:38px;line-height:1.25;font-weight:${appearance.headingWeight}}
h2{font-size:25px;line-height:1.35;margin:0 0 16px}
h3{font-size:18px;line-height:1.45;margin:24px 0 8px;color:var(--accent)}
section{background:var(--surface);border:var(--border-width) solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:25px;margin:18px 0}
small{float:right;color:var(--accent);font-size:14px}.lead{color:var(--muted);font-size:15px}
.question{background:var(--subtle);padding:12px;border-radius:var(--radius)}
.dimension{border-top:1px solid var(--line);padding:13px 0}.dimension p{margin:8px 0;color:var(--muted);font-size:15px;line-height:1.75}
ul{padding-left:22px}li+li{margin-top:8px}
@media(max-width:600px){body{font-size:16px;margin:20px auto;padding:0 16px}h1{font-size:30px}h2{font-size:22px}section{padding:19px}}
@media print{html{background:#fff}body{background:#fff;color:#111;margin:0}section{background:#fff;color:#111;border:1px solid #ddd;box-shadow:none;break-inside:avoid}}`
}

export function createReportHtml(session: Session, appearance: ReportAppearance): string {
  const stats = reportStats(session)
  const score = overallScore(session)
  const rows = session.tasks.map((task, index) => {
    const answer = session.answers.find(item => item.taskId === task.id)
    if (!answer || answer.status === 'skipped') return `<section><h2>${index + 1}. ${escape(task.title)}</h2><p>已跳过，计入总分的满分范围。</p></section>`
    const value = questionScore(answer)
    const evaluation = answer.evaluation
    return `<section><h2>${index + 1}. ${escape(task.title)} <small>${value === null ? '待评估' : `${value.toFixed(1)} / 5`}</small></h2><p class="question">${escape(task.prompt)}</p><h3>总体评价</h3><p>${escape(evaluation?.summary || '待评估')}</p><h3>建议回答方式</h3><p>${escape(evaluation?.suggestedAnswer || evaluation?.nextStep || '待评估')}</p><h3>评分依据</h3>${(evaluation?.dimensions || []).map(d => `<div class="dimension"><strong>${escape(d.name)} · ${d.score === null ? '无法评价' : `${d.score} / 5`} · 权重 ${Math.round(d.weight * 100)}%</strong><p>证据：${escape(d.evidence)}</p><p>建议：${escape(d.advice)}</p></div>`).join('')}</section>`
  }).join('')
  const list = (items: string[]) => items.length ? `<ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '<p>暂无</p>'
  return `<!doctype html><html lang="zh-CN" data-theme="${escape(appearance.id)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoMind 练习报告</title><style>${reportStyle(appearance)}</style></head><body><h1>练习报告</h1><p class="lead">${escape(new Date(session.createdAt).toLocaleString('zh-CN'))} · ${session.mode === 'interview' ? '模拟面试' : '工作汇报'}</p><section><h2>整场表现</h2><p><strong>总分：${score.complete ? `${(score.earned / score.maximum * 100).toFixed(1)} / 100` : '待评估'}</strong>（${score.earned.toFixed(1)} / ${score.maximum} 原始分；跳过题计 0 分）</p><p>${escape(session.overallAnalysis?.summary || '整场分析待生成。')}</p><h3>优势</h3>${list(session.overallAnalysis?.strengths || [])}<h3>优先改进</h3>${list(session.overallAnalysis?.priorities || [])}</section><section><h2>表达习惯</h2><p>语气词：${Object.entries(stats.fillers).map(([word, count]) => `${escape(word)} ${count} 次`).join(' · ')}</p><p>重复连接词：${Object.entries(stats.transitions).map(([word, count]) => `${escape(word)} ${count} 次`).join(' · ')}</p><p>相邻重复表达：${stats.repeatedPhrases.length ? stats.repeatedPhrases.map(([phrase, count]) => `“${escape(phrase)}” ${count} 次`).join(' · ') : '未检出'}</p><p>长停顿：${stats.pauses} 次。以上为原始转写和音量事件估算，仅供练习参考，不参与评分。</p></section>${rows}</body></html>`
}
