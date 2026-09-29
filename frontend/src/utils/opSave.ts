import { encodeOPSaveRequest } from '@1password/save-button'

type SaveRequest = Parameters<typeof encodeOPSaveRequest>[0]
type SaveField = SaveRequest['fields'][number]

export function buildOPSaveValue(publicUrl: string, token: string): string {
  // The package types autocomplete as an ambient const enum, which cannot be
  // referenced under isolatedModules; the string values are its real members.
  const field = { autocomplete: 'current-password', value: token } as unknown as SaveField
  const request = {
    title: 'CQU Schedule',
    fields: [field],
    urls: [publicUrl],
  } as SaveRequest
  return encodeOPSaveRequest(request) ?? ''
}
