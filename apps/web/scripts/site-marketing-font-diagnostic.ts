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
  beforeProbe: { maxWidth: string; fontSize: string; originNoteMatches: number }
  matchedFontRules: { rules: string[]; truncated: boolean }
  before: FontMetricDiagnostic; after: FontMetricDiagnostic
  platformBefore: PlatformFontDiagnostic[]; platformAfter: PlatformFontDiagnostic[]
}

interface MatchedFontStyle { cssProperties: readonly { name: string; value: string; disabled?: boolean }[] }
interface MatchedFontSource {
  inlineStyle?: MatchedFontStyle
  matchedCSSRules?: readonly { rule: { selectorList: { text: string }; style: MatchedFontStyle } }[]
  inherited?: readonly { inlineStyle?: MatchedFontStyle; matchedCSSRules: readonly { rule: { selectorList: { text: string }; style: MatchedFontStyle } }[] }[]
}
/** At most eight compact rules, each <=224 encoded UTF-8 bytes, so both sides
 * fit beside the already bounded font samples without emitting raw CSS. */
export function selectMarketingFontRules(input: MatchedFontSource): { rules: string[]; truncated: boolean } {
  const rules: string[] = []; let truncated = false
  const select = (scope: string, selector: string, style: MatchedFontStyle) => {
    const properties = style.cssProperties.slice(0, 128).filter(property => !property.disabled && /^(?:font(?:-[a-z-]+)?|max-width)$/u.test(property.name))
    if (style.cssProperties.length > 128) truncated = true
    if (properties.length === 0) return
    if (rules.length === 8) { truncated = true; return }
    // Size/cap declarations precede ancillary font settings in a truncated rule.
    const priority = (name: string) => ["font-size", "max-width", "font", "font-family"].indexOf(name)
    properties.sort((a, b) => (priority(a.name) < 0 ? 4 : priority(a.name)) - (priority(b.name) < 0 ? 4 : priority(b.name)))
    if (properties.length > 4) truncated = true
    if (selector.length > 128 || properties.slice(0, 4).some(property => property.name.length > 32 || property.value.length > 128)) truncated = true
    const text = `${scope} ${selector.slice(0, 128)} {${properties.slice(0, 4).map(property => `${property.name.slice(0, 32)}:${property.value.slice(0, 128)}`).join(";")}}`
      .replace(/[\x00-\x1f]/gu, " ")
    let bounded = ""
    for (const character of text) {
      if (Buffer.byteLength(JSON.stringify(bounded + character), "utf8") > 224) { truncated = true; break }
      bounded += character
    }
    rules.push(bounded)
  }
  const group = (scope: string, source: MatchedFontSource) => {
    if (source.inlineStyle) select(scope, "<inline>", source.inlineStyle)
    const matches = source.matchedCSSRules ?? []
    if (matches.length > 64) truncated = true
    for (const { rule } of matches.slice(0, 64)) select(scope, rule.selectorList.text, rule.style)
  }
  group("note", input)
  if ((input.inherited?.length ?? 0) > 8) truncated = true
  for (const [index, source] of (input.inherited ?? []).slice(0, 8).entries()) group(`ancestor${index + 1}`, source)
  return { rules, truncated }
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
  const beforeProbe = await page.evaluate(selector => {
    const note = document.querySelector(selector)
    if (!(note instanceof HTMLElement)) throw new Error("Font diagnostic note missing")
    const style = getComputedStyle(note)
    return { maxWidth: style.maxWidth, fontSize: style.fontSize, originNoteMatches: document.querySelectorAll(".origin-note").length }
  }, selector)
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
    const documentNode = await session.send("DOM.getDocument", { depth: 0 })
    const noteNode = await session.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector })
    assert.ok(noteNode.nodeId > 0)
    const matchedFontRules = selectMarketingFontRules(await session.send("CSS.getMatchedStylesForNode", { nodeId: noteNode.nodeId }))
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
    result = { kind: "marketing-font-diagnostic", selector, capturedMaxWidth, beforeProbe, matchedFontRules, before, after, platformBefore, platformAfter }
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
