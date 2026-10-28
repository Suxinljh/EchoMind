import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ChangelogPage from './ChangelogPage'
import ErrorBoundary from './ErrorBoundary'
import 'newspaperui/style.css'
import { readTheme } from './themes'
import { reloadForChunkError } from './chunkLoad'

document.documentElement.dataset.theme = readTheme()

// 部署会替换带 hash 的 chunk：旧标签页按需加载失败时刷新一次，避免出现原始的错误提示。
window.addEventListener('vite:preloadError', event => {
  event.preventDefault()
  reloadForChunkError((event as Event & { payload?: unknown }).payload)
})
window.addEventListener('unhandledrejection', event => {
  if (reloadForChunkError(event.reason)) event.preventDefault()
})

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary>{window.location.pathname === '/changelog' ? <ChangelogPage/> : <App/>}</ErrorBoundary></React.StrictMode>)
