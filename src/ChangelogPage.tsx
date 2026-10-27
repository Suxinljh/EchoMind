import { useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, GitBranch, ShieldCheck } from 'lucide-react'
import changelogText from '../CHANGELOG.md?raw'
import Logo from './Logo'
import packageJson from '../package.json'
import './changelog.css'

type ChangeType = '发布' | '更新' | '优化' | '修复' | '公告'
type Change = { date: string; type: ChangeType; title: string; description: string; details: string[] }
const types: ChangeType[] = ['发布', '更新', '优化', '修复', '公告']
const headingPattern = /^### \[(发布|更新|优化|修复|公告)\] (.+)$/
const github = 'https://github.com/Suxinljh/EchoMind'

function readChanges(source: string): Change[] {
  const changes: Change[] = []
  let date = ''
  let warned = false
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^## \d{4}-\d{2}-\d{2}$/.test(line)) {
      date = line.slice(3)
    } else if (line.startsWith('### [') && date) {
      const match = headingPattern.exec(line)
      if (match) changes.push({ date, type: match[1] as ChangeType, title: match[2], description: '', details: [] })
      else if (changes.length) {
        // 未知分类不静默丢弃：降级为上一条的正文，保证内容仍可见。
        const change = changes[changes.length - 1]
        const text = line.replace(/^###\s*/, '')
        change.description += (change.description ? '\n' : '') + text
      } else if (!warned) {
        warned = true
        console.warn(`更新日志有无法识别的条目标题，未单独展示：${line}`)
      }
    } else if (line && changes.length) {
      const change = changes[changes.length - 1]
      if (line.startsWith('- ')) change.details.push(line.slice(2))
      else change.description += (change.description ? '\n' : '') + line
    }
  }
  return changes
}

const changes = readChanges(changelogText)
const months = [...new Set(changes.map(item => item.date.slice(0, 7)))]
const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function dateLabel(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return `${year} 年 ${month} 月 ${day} 日`
}

export default function ChangelogPage() {
  const [activeType, setActiveType] = useState<ChangeType | '全部'>('全部')
  const [activeMonth, setActiveMonth] = useState('全部')
  const filtered = useMemo(() => changes.filter(item => (activeType === '全部' || item.type === activeType) && (activeMonth === '全部' || item.date.startsWith(activeMonth))), [activeType, activeMonth])
  const dates = [...new Set(filtered.map(item => item.date))]

  return <div className="app-shell changelog-shell">
    <header className="topbar"><div className="brand-group"><a className="brand" href="/" aria-label="EchoMind 首页"><Logo/></a><span className="beta-badge">v{packageJson.version} Beta</span></div><a className="changelog-top-back" href="/"><ArrowLeft size={16}/> 返回练习</a></header>
    <div className="layout">
      <aside className="sidebar">
        <a className="changelog-home-link" href="/"><ArrowLeft size={17}/> 返回练习</a>
        <div className="sidebar-meta">
          <a className="sidebar-link" href={github} target="_blank" rel="noopener noreferrer"><GitBranch size={17}/> GitHub <ExternalLink size={14}/></a>
          <div className="sidebar-bottom"><div className="sidebar-bottom-head"><ShieldCheck size={20}/><strong>隐私优先</strong></div><p>音频在浏览器内处理。练习文字保存在本机浏览器；启用模型后才会发送指定文字。</p></div>
        </div>
      </aside>
      <main className="main-area changelog-main">
        <div className="changelog-layout">
          <div className="changelog-feed">
            <div className="changelog-intro"><h1>更新日志</h1><p>新功能、调整与修复，都记录在这里。</p></div>
            {dates.length ? dates.map(date => <section className="changelog-day" key={date} id={`d-${date}`}>
              <h2>{dateLabel(date)} <small>{weekday[new Date(`${date}T00:00:00`).getDay()]}</small></h2>
              {filtered.filter(item => item.date === date).map(item => <article className="changelog-entry" key={item.title}>
                <div className="changelog-entry-meta"><span className={`changelog-dot type-${item.type}`}/>{item.type}</div>
                <div className="changelog-entry-body"><h3>{item.title}</h3>{item.description.split('\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}{item.details.length > 0 && <ul>{item.details.map(detail => <li key={detail}>{detail}</li>)}</ul>}</div>
              </article>)}
            </section>) : <div className="changelog-empty">这个筛选条件下还没有更新。</div>}
          </div>
          <aside className="changelog-filters">
            <section><h2>按类型看</h2><button className={activeType === '全部' ? 'active' : ''} onClick={() => setActiveType('全部')}><span><i className="changelog-dot type-all"/>全部</span><small>{changes.length}</small></button>{types.filter(type => changes.some(item => item.type === type)).map(type => <button key={type} className={activeType === type ? 'active' : ''} onClick={() => setActiveType(type)}><span><i className={`changelog-dot type-${type}`}/>{type}</span><small>{changes.filter(item => item.type === type).length}</small></button>)}</section>
            <section><h2>按月份</h2><button className={activeMonth === '全部' ? 'active' : ''} onClick={() => setActiveMonth('全部')}><span>全部月份</span><small>{changes.length}</small></button>{months.map(month => { const [year, number] = month.split('-').map(Number); return <button key={month} className={activeMonth === month ? 'active' : ''} onClick={() => setActiveMonth(month)}><span>{year} 年 {number} 月</span><small>{changes.filter(item => item.date.startsWith(month)).length} 条</small></button> })}</section>
            <section className="changelog-feedback"><h2>有想法或遇到问题</h2><p>欢迎在 GitHub 提出建议或反馈问题。</p><a href={`${github}/issues`} target="_blank" rel="noopener noreferrer">前往 GitHub Issues <ExternalLink size={14}/></a></section>
          </aside>
        </div>
      </main>
    </div>
  </div>
}
