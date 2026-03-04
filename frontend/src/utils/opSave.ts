import { encodeOPSaveRequest } from '@1password/save-button'
import { useConfigStore } from '@/stores/config.js'

export function buildOPSaveValue(token: string): string {
  const configStore = useConfigStore()
  return encodeOPSaveRequest({
    title: 'CQU Schedule',
    fields: [{ autocomplete: 'current-password', value: token }],
    urls: [configStore.publicUrl],
  })
}
