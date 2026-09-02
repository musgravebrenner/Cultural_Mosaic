import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import App from './App'
import './styles/theme.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
