import './wails-api'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import 'font-logos/assets/font-logos.css'
import { applyAppearance, readCachedAppearance } from './theme/applyAppearance'
import { registerTerminalFonts } from './theme/terminalFonts'
import { initFileDrop } from './fileDrop'

registerTerminalFonts()
initFileDrop()
applyAppearance(readCachedAppearance(), false)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
