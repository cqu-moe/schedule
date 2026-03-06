import { vi } from 'vitest'
import { config } from '@vue/test-utils'

// Mock navigator.clipboard (not fully implemented in jsdom)
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
})

// Mock window.open
vi.stubGlobal('open', vi.fn())

// Global stubs for teleporting components (Dialog, AlertDialog, DropdownMenu, Popover, Select)
config.global.stubs = {
  AlertDialog: { template: '<div><slot /></div>', props: ['open'] },
  AlertDialogContent: { template: '<div><slot /></div>' },
  AlertDialogHeader: { template: '<div><slot /></div>' },
  AlertDialogFooter: { template: '<div><slot /></div>' },
  AlertDialogTitle: { template: '<span><slot /></span>' },
  AlertDialogDescription: { template: '<span><slot /></span>' },
  AlertDialogTrigger: { template: '<span><slot /></span>', props: ['asChild'] },
  AlertDialogAction: {
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    props: ['disabled'],
    emits: ['click'],
  },
  AlertDialogCancel: {
    template: '<button @click="$emit(\'click\')"><slot /></button>',
    emits: ['click'],
  },
  Dialog: { template: '<div v-if="open"><slot /></div>', props: ['open'] },
  DialogContent: { template: '<div><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogFooter: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<span><slot /></span>' },
  DialogDescription: { template: '<span><slot /></span>' },
  DropdownMenu: { template: '<div><slot /></div>' },
  DropdownMenuContent: { template: '<div><slot /></div>' },
  DropdownMenuItem: {
    template: '<div @click="$emit(\'click\')"><slot /></div>',
    emits: ['click'],
  },
  DropdownMenuTrigger: { template: '<span><slot /></span>', props: ['asChild'] },
}

// Mock @hcaptcha/vue3-hcaptcha globally
vi.mock('@hcaptcha/vue3-hcaptcha', () => ({
  default: {
    name: 'VueHcaptcha',
    template: '<div data-testid="hcaptcha" />',
    props: ['sitekey', 'size'],
    setup() {
      const executeAsync = vi.fn().mockResolvedValue({ response: 'mock-captcha-token' })
      const reset = vi.fn()
      return { executeAsync, reset }
    },
  },
}))

// Mock qrcode.vue globally
vi.mock('qrcode.vue', () => ({
  default: {
    name: 'QrcodeVue',
    template: '<div data-testid="qrcode" />',
    props: ['value', 'size', 'level'],
  },
}))

// Mock @1password/save-button globally
vi.mock('@1password/save-button', () => ({
  encodeOPSaveRequest: vi.fn().mockReturnValue('mock-encoded'),
  activateOPButton: vi.fn(),
}))

// Mock @vueuse/core useColorMode for Navbar tests, keep real utilities
vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>()
  const store = { value: 'auto' }
  return {
    ...actual,
    useColorMode: vi.fn(() => ({ store })),
  }
})

// Mock @fullcalendar/vue3
vi.mock('@fullcalendar/vue3', () => ({
  default: {
    name: 'FullCalendar',
    template: '<div data-testid="fullcalendar" />',
    props: ['options'],
  },
}))

// Mock FullCalendar plugins (they export plugin objects)
vi.mock('@fullcalendar/daygrid', () => ({ default: {} }))
vi.mock('@fullcalendar/timegrid', () => ({ default: {} }))
