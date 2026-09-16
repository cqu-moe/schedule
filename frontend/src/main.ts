import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './assets/styles/globals.css'
import { captureScheduleException, initPostHog } from './lib/posthog'

const app = createApp(App)

initPostHog()
app.config.errorHandler = (error, _instance, info) => {
  captureScheduleException(error, { source: 'vue', info })
}

app.use(createPinia())
app.use(router)

app.mount('#app')
