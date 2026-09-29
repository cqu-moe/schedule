import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Mock navigator.clipboard (not fully implemented in jsdom)
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
})

// Mock window.open
vi.stubGlobal('open', vi.fn())

// Mock qrcode.react
vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => <div data-testid="qrcode" />,
}))

// Mock @1password/save-button
vi.mock('@1password/save-button', () => ({
  encodeOPSaveRequest: vi.fn().mockReturnValue('mock-encoded'),
  activateOPButton: vi.fn(),
}))

// Mock FullCalendar React component (plugins export plain objects)
vi.mock('@fullcalendar/react', () => ({
  default: () => <div data-testid="fullcalendar" />,
}))
vi.mock('@fullcalendar/daygrid', () => ({ default: {} }))
vi.mock('@fullcalendar/timegrid', () => ({ default: {} }))
