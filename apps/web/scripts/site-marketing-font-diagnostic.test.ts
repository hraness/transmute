import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import type { Page } from "playwright-core"
import { collectMarketingFontDiagnostic, encodeMarketingFontDiagnostic, selectMarketingFontRules } from "./site-marketing-font-diagnostic"

test("font diagnostic limits UTF-8 bytes rather than only character count", () => {
  expect(encodeMarketingFontDiagnostic({ measured: "62ch" })).toBe('{"measured":"62ch"}')
  expect(() => encodeMarketingFontDiagnostic({ measured: "a".repeat(32768) })).toThrow("32 KiB")
  expect(() => encodeMarketingFontDiagnostic({ measured: "📇".repeat(8192) })).toThrow("32 KiB")
})

test("arbitrary Unicode diagnostics preserve exact JSON through the byte boundary and reject one additional glyph", () => {
  let state = 0x666f6e74
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
  const alphabet = ["a", "é", "中", "📇", "\n", '"', "\ud800"]
  for (let index = 0; index < 64; index++) {
    const prefix = Array.from({ length: next() % 1024 }, () => alphabet[next() % alphabet.length]!).join("")
    const value = { sample: prefix }
    expect(encodeMarketingFontDiagnostic(value)).toBe(JSON.stringify(value))
    const remaining = 32 * 1024 - Buffer.byteLength(JSON.stringify(value), "utf8")
    const boundary = { sample: prefix + "a".repeat(remaining) }
    const encoded = encodeMarketingFontDiagnostic(boundary)
    expect(encoded).toBe(JSON.stringify(boundary)); expect(Buffer.byteLength(encoded, "utf8")).toBe(32 * 1024)
    expect(() => encodeMarketingFontDiagnostic({ sample: boundary.sample + "📇" })).toThrow("32 KiB")
  }
})

function readOnlyPage(failAt?: string, failDetach = false) {
  const events: string[] = [], operationError = new Error("Font observation failed"), detachError = new Error("Detach failed")
  class Element {
    tagName = "P"
    parentElement = null
    getBoundingClientRect() { return { x: 10, y: 20, width: 192, height: 205.3125 } }
  }
  const note = new Element(), fonts = [{ family: "Nebula Sans", style: "normal", weight: "400", stretch: "normal", status: "loaded", display: "swap", unicodeRange: "U+0-10FFFF" }]
  Object.defineProperties(fonts, { status: { value: "loaded" }, load: { get() { throw new Error("Diagnostic must not load fonts") } }, ready: { get() { throw new Error("Diagnostic must not settle fonts") } } })
  const document = { fonts, querySelector: () => note, querySelectorAll: () => [] }
  const session = { send: async (method: string) => {
    events.push(method)
    if (method === failAt) throw operationError
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } }
    if (method === "DOM.querySelector") return { nodeId: 2 }
    if (method === "CSS.getPlatformFontsForNode") return { fonts: [{ familyName: "Nebula Sans", postScriptName: "NebulaSans-Book", isCustomFont: true, glyphCount: 1 }] }
    return {}
  }, detach: async () => { events.push("detach"); if (failDetach) throw detachError } }
  const page = { evaluate: async (callback: (value: unknown) => unknown, value: unknown) => {
    events.push("snapshot")
    if (failAt === "snapshot") throw operationError
    return runInNewContext(`(${callback.toString()})(${JSON.stringify(value)})`, {
      document, HTMLElement: Element,
      getComputedStyle: () => ({ maxWidth: "556.71px", getPropertyValue: (name: string) => name === "font-size" ? "14.72px" : "normal" }),
    }) as unknown
  }, context: () => ({ newCDPSession: async () => {
    events.push("session")
    if (failAt === "session") throw operationError
    return session
  } }) } as unknown as Page
  return { page, events, operationError, detachError }
}

test("font diagnostic preserves the original measurement with one read-only snapshot and no font settlement", async () => {
  const { page, events } = readOnlyPage()
  const result = await collectMarketingFontDiagnostic(page, "574.856px")
  expect(result.capturedMaxWidth).toBe("574.856px")
  expect(result.snapshot.maxWidth).toBe("556.71px")
  expect(result.snapshot.rect).toEqual([10, 20, 192, 205.3125])
  expect(result.snapshot.styles["font-size"]).toBe("14.72px")
  expect(result.snapshot.originNoteMatches).toBe(0)
  expect(result.platformFonts[0]?.postScriptName).toBe("NebulaSans-Book")
  expect(events.filter(event => event === "snapshot")).toHaveLength(1)
  expect(events.at(-1)).toBe("detach")
})

test("font diagnostic detaches its owned session on every observation failure and refuses cleanup failures", async () => {
  for (const failAt of ["snapshot", "session", "DOM.enable", "CSS.enable", "DOM.getDocument", "DOM.querySelector", "CSS.getPlatformFontsForNode", "CSS.getMatchedStylesForNode", undefined]) {
    for (const failDetach of [false, true]) {
      if (failAt === undefined && !failDetach) continue
      const { page, events, operationError, detachError } = readOnlyPage(failAt, failDetach)
      const failure = await collectMarketingFontDiagnostic(page, "574.856px").catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError)) throw new Error("Expected the diagnostic to fail")
      const ownsSession = failAt !== "snapshot" && failAt !== "session"
      expect(failure.errors).toEqual([...(failAt === undefined ? [] : [operationError]), ...(ownsSession && failDetach ? [detachError] : [])])
      expect(events.filter(event => event === "detach")).toHaveLength(ownsSession ? 1 : 0)
    }
  }
})

test("matched font diagnostics retain cap and size rules while refusing unrelated CSS and bounding arbitrary selectors", () => {
  const rule = (text: string) => ({ rule: { selectorList: { text }, style: { cssProperties: [
    { name: "color", value: "red" }, { name: "font-size", value: ".92rem" }, { name: "max-width", value: "62ch" },
    { name: "font-size", value: ".95rem", disabled: true },
  ] } } })
  expect(selectMarketingFontRules({ matchedCSSRules: [rule(".install-note")] })).toEqual({ rules: ["note .install-note {font-size:.92rem;max-width:62ch}"], truncated: false })
  expect(selectMarketingFontRules({ matchedCSSRules: [rule("a".repeat(129))] }).truncated).toBe(true)
  for (let length = 0; length < 64; length++) {
    const result = selectMarketingFontRules({ matchedCSSRules: Array.from({ length }, () => rule("📇\n".repeat(length + 1))) })
    expect(result.rules.length).toBeLessThanOrEqual(8)
    for (const value of result.rules) expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(224)
    if (length > 8) expect(result.truncated).toBe(true)
  }
})
