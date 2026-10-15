import { Component, type ErrorInfo, type ReactNode } from 'react'

const historyKey = 'echomind-practice-history-v1'

type Props = { children: ReactNode }
type State = { message: string }

// 单条损坏的本地数据不应该让整个页面白屏。
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('EchoMind 渲染失败', error, info.componentStack)
  }

  render() {
    if (!this.state.message) return this.props.children
    return <div className="app-shell"><main className="main-area"><div className="home-page">
      <h1>页面没能正常显示</h1>
      <p className="hero-copy">本地保存的练习数据可能已损坏。可以先清除本地练习数据再重试；模型地址与 API Key 不会被清除。</p>
      <p className="muted">错误信息：{this.state.message}</p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={() => { try { localStorage.removeItem(historyKey) } catch { /* 忽略：清除失败时仍可重新加载。 */ } window.location.reload() }}>清除本地练习数据并重载</button>
        <button className="primary-button" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    </div></main></div>
  }
}
