import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import html from '../index.html?raw'

it('keeps scripts in the shared calendar document on the application origin', () => {
  const origin = 'https://schedule.cqu.moe'
  const dom = new JSDOM(html, {
    url: `${origin}/view/synthetic-token`,
  })
  try {
    const scripts = [...dom.window.document.querySelectorAll<HTMLScriptElement>('script[src]')]
    expect(scripts.some(script => script.type === 'module')).toBe(true)
    expect(scripts.map(script => new URL(script.src).origin)).toEqual(
      scripts.map(() => origin),
    )
  } finally {
    dom.window.close()
  }
})
