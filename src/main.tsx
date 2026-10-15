import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ChangelogPage from './ChangelogPage'
import ErrorBoundary from './ErrorBoundary'
import 'newspaperui/style.css'
import { readTheme } from './themes'

document.documentElement.dataset.theme = readTheme()

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary>{window.location.pathname === '/changelog' ? <ChangelogPage/> : <App/>}</ErrorBoundary></React.StrictMode>)
