import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { ThemeProvider, Toaster } from '@cqu-moe/ui'
import '@cqu-moe/theme/styles.css'
import '@cqu-moe/ui/styles.css'
import './styles.css'
import { router } from '@/router'
import { AppProvider } from '@/providers/app'
import { captureScheduleException, initPostHog } from '@/lib/posthog'

initPostHog()

createRoot(document.getElementById('root')!, {
  onUncaughtError(error) {
    captureScheduleException(error, { source: 'react' })
  },
}).render(
  <StrictMode>
    <ThemeProvider>
      <AppProvider>
        <RouterProvider router={router} />
      </AppProvider>
      <Toaster />
    </ThemeProvider>
  </StrictMode>,
)

