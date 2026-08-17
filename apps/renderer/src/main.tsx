import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { createRuntime } from './runtime'
import './index.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root element')

const runtime = createRuntime({ search: window.location.search })
runtime.start()

createRoot(container).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
)
