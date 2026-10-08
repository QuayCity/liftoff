import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DesignPage } from './design/DesignPage'
import './index.css'
import { OverlayProvider } from './ui/overlays'

// ?theme=dark|light forces a theme (screenshots); ?design shows the component sheet.
const params = new URLSearchParams(location.search)
const forced = params.get('theme')
if (forced) document.documentElement.dataset.theme = forced

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {params.has('design') ? <DesignPage /> : <OverlayProvider><App /></OverlayProvider>}
  </StrictMode>,
)
