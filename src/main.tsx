import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ChangelogPage from './ChangelogPage'
import 'newspaperui/style.css'
import { readTheme } from './themes'

document.documentElement.dataset.theme = readTheme()

createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.pathname === '/changelog' ? <ChangelogPage/> : <App/>}</React.StrictMode>)
