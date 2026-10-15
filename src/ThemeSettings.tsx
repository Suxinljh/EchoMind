import { useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from './components/ui/button'
import { defaultTheme, themes, type ThemeId } from './themes'

type Props = { selected: ThemeId; onSelect: (theme: ThemeId) => void }

export default function ThemeSettings({ selected, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const matching = themes.filter(([id, name]) => `${id} ${name}`.toLowerCase().includes(query.trim().toLowerCase()))

  return <div className="theme-settings" role="tabpanel" id="theme-settings-panel" aria-labelledby="theme-settings-tab">
    <p className="settings-intro">选择后立即应用到页面，并保存在此浏览器中。含 DaisyUI 内置主题、报纸风与粗犷风，共 {themes.length} 种。</p>
    <div className="theme-tools"><label className="field">查找主题<input value={query} onChange={event => setQuery(event.target.value)} placeholder="输入主题名称"/></label>{selected === 'neobrutalism' ? <Button variant="secondary" onClick={() => onSelect(defaultTheme)}>恢复默认主题</Button> : <button className="text-button" onClick={() => onSelect(defaultTheme)}>恢复默认主题</button>}</div>
    <div className="theme-grid">
      {matching.map(([id, name]) => <button key={id} type="button" className={`theme-option ${selected === id ? 'selected' : ''}`} data-theme={id} aria-pressed={selected === id} onClick={() => onSelect(id)}>
        <span className="theme-option-copy"><strong>{name}</strong><small>{id}</small></span>
        <span className="theme-swatches" aria-hidden="true"><i/><i/><i/></span>
        {selected === id && <Check className="theme-check" size={17} aria-hidden="true"/>}
      </button>)}
    </div>
    {matching.length === 0 && <p className="muted">没有找到匹配的主题。</p>}
  </div>
}
