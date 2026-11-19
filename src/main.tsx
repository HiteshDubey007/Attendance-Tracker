import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initBackend } from '@backend'
import App from './App.tsx'

/*  PunchIn — office attendance. Developed by Hitesh Dubey.  */
initBackend().then(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
})
