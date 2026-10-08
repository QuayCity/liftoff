import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { DesignPage } from './design/DesignPage'

// ?theme=dark|light forces a theme (used for design screenshots).
const forced = new URLSearchParams(location.search).get('theme')
if (forced) document.documentElement.dataset.theme = forced

// ponytail: only the /design page exists until the app shell and routing are added.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesignPage />
  </StrictMode>,
)
