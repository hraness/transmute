import assert from "node:assert/strict"
import type { CDPSession, Page } from "playwright-core"

const selector = ".hraness-marketing-install__heading-group > .install-note"
const fontProperties = ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant", "font-variant-numeric",
  "font-variant-ligatures", "font-feature-settings", "font-variation-settings", "font-size-adjust", "font-optical-sizing", "font-kerning",
  "font-synthesis", "letter-spacing", "word-spacing", "text-rendering", "text-transform", "writing-mode", "direction"] as const
interface FontFaceDiagnostic { family: string; style: string; weight: string; stretch: string; status: string; display: string; unicodeRange: string }
interface FontMetricDiagnostic {
  maxWidth: string; rect: number[]; styles: Record<string, string>; ancestors: Array<{ tag: string; styles: Record<string, string> }>
  fonts: FontFaceDiagnostic[]; fontCount: number; fontStatus: string
  probe: { oneChPx: number; zeroTextPx: number; computedWidth: string }
}
interface PlatformFontDiagnostic { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number }
export interface MarketingFontDiagnostic {
  kind: "marketing-font-diagnostic"; selector: string; capturedMaxWidth: string
  before: FontMetricDiagnostic; after: FontMetricDiagnostic
  platformBefore: PlatformFontDiagnostic[]; platformAfter: PlatformFontDiagnostic[]
}

/** Diagnostic-only serialization; this cannot qualify or replace measured evidence. */
export function encodeMarketingFontDiagnostic(value: unknown): string {
  const text = JSON.stringify(value)
  assert.ok(typeof text === "string" && Buffer.byteLength(text, "utf8") <= 32 * 1024, "Font diagnostic exceeds 32 KiB")
  return text
}

async function platformFonts(session: CDPSession): Promise<PlatformFontDiagnostic[]> {
  const document = await session.send("DOM.getDocument", { depth: 0 })
  const node = await session.send("DOM.querySelector", { nodeId: document.root.nodeId, selector })
  assert.ok(node.nodeId > 0, "Font diagnostic note missing")
  const result = await session.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })
  assert.ok(result.fonts.length <= 16, "Font diagnostic platform inventory exceeds bound")
  return result.fonts.map(font => {
    assert.ok(Number.isSafeInteger(font.glyphCount) && font.glyphCount >= 0)
    assert.ok(font.familyName.length <= 256 && font.postScriptName.length <= 256)
    return { familyName: font.familyName, postScriptName: font.postScriptName, isCustomFont: font.isCustomFont, glyphCount: font.glyphCount }
  })
}

/** Preserve the earlier captured value. The later explicit zero-glyph load is
 * diagnostic only and never changes target styles or the acceptance record. */
export async function collectMarketingFontDiagnostic(page: Page, capturedMaxWidth: string): Promise<MarketingFontDiagnostic> {
  assert.ok(capturedMaxWidth.length > 0 && capturedMaxWidth.length <= 256)
  const probe = await page.evaluateHandle(({ selector, fontProperties }) => {
    const note = document.querySelector(selector)
    if (!(note instanceof HTMLElement)) throw new Error("Font diagnostic note missing")
    const style = getComputedStyle(note), probe = document.createElement("span")
    probe.textContent = "0"
    probe.style.cssText = "position:fixed;left:0;top:-10000px;display:block;width:1ch;min-width:0;max-width:none;height:auto;margin:0;padding:0;border:0;box-sizing:content-box;visibility:hidden;pointer-events:none"
    for (const property of fontProperties) probe.style.setProperty(property, style.getPropertyValue(property))
    document.body.append(probe)
    return probe
  }, { selector, fontProperties })
  let session: CDPSession | undefined, result: MarketingFontDiagnostic | undefined
  const failures: unknown[] = []
  try {
    session = await page.context().newCDPSession(page)
    await session.send("DOM.enable"); await session.send("CSS.enable")
    const sample = () => probe.evaluate((probe, { selector, fontProperties }): FontMetricDiagnostic => {
      const note = document.querySelector(selector)
      if (!(note instanceof HTMLElement) || !probe.isConnected) throw new Error("Font diagnostic ownership lost")
      const pick = (element: Element) => {
        const style = getComputedStyle(element)
        return Object.fromEntries(fontProperties.map(property => [property, style.getPropertyValue(property).slice(0, 512)]))
      }
      const style = getComputedStyle(note), rect = note.getBoundingClientRect(), ancestors = []
      let ancestor = note.parentElement
      for (let depth = 0; ancestor !== null && depth < 8; depth++, ancestor = ancestor.parentElement)
        ancestors.push({ tag: ancestor.tagName, styles: pick(ancestor) })
      const faces = [...document.fonts].filter(face => face.family.replaceAll('"', "") === "Nebula Sans")
      const fonts = faces.slice(0, 16).map(face => ({ family: face.family.slice(0, 256), style: face.style.slice(0, 256),
        weight: face.weight.slice(0, 256), stretch: face.stretch.slice(0, 256), status: face.status, display: face.display,
        unicodeRange: face.unicodeRange.slice(0, 256) }))
      const range = document.createRange(); range.selectNodeContents(probe)
      const oneChPx = probe.getBoundingClientRect().width, zeroTextPx = range.getBoundingClientRect().width
      if (![rect.x, rect.y, rect.width, rect.height, oneChPx, zeroTextPx].every(Number.isFinite)) throw new Error("Nonfinite font geometry")
      return { maxWidth: style.maxWidth, rect: [rect.x, rect.y, rect.width, rect.height], styles: pick(note), ancestors, fonts,
        fontCount: faces.length, fontStatus: document.fonts.status, probe: { oneChPx, zeroTextPx, computedWidth: getComputedStyle(probe).width } }
    }, { selector, fontProperties })
    const before = await sample(), platformBefore = await platformFonts(session)
    await page.evaluate(async selector => {
      const note = document.querySelector(selector)
      if (!(note instanceof HTMLElement)) throw new Error("Font diagnostic note missing")
      const style = getComputedStyle(note)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            await document.fonts.load(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, "0")
            await document.fonts.ready
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Font diagnostic load did not settle")), 2_000) }),
        ])
      } finally { clearTimeout(timer) }
    }, selector)
    const after = await sample(), platformAfter = await platformFonts(session)
    result = { kind: "marketing-font-diagnostic", selector, capturedMaxWidth, before, after, platformBefore, platformAfter }
    encodeMarketingFontDiagnostic(result)
  } catch (error) { failures.push(error) }
  finally {
    try { await probe.evaluate(probe => probe.remove()) } catch (error) { failures.push(error) }
    try { await probe.dispose() } catch (error) { failures.push(error) }
    if (session !== undefined) try { await session.detach() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Font diagnostic or owned cleanup failed")
  assert.ok(result !== undefined)
  return result
}
