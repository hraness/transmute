import { expect, test } from "bun:test"
import type { Page } from "playwright-core"
import { collectMarketingFontDiagnostic, encodeMarketingFontDiagnostic } from "./site-marketing-font-diagnostic"

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

test("font diagnostic preserves the prior measurement and always removes owned resources", async () => {
  for (const fail of [false, true]) {
    const events: string[] = [], failure = new Error("Platform font observation failed")
    let samples = 0
    const probe = { evaluate: () => {
      samples++
      if (samples > (fail ? 1 : 2)) { events.push("remove"); return Promise.resolve() }
      return Promise.resolve({ maxWidth: samples === 1 ? "574.856px" : "556.71px" })
    }, dispose: async () => { events.push("dispose") } }
    const session = { send: async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } }
      if (method === "DOM.querySelector") return { nodeId: 2 }
      if (method === "CSS.getPlatformFontsForNode") {
        if (fail) throw failure
        return { fonts: [{ familyName: "Nebula Sans", postScriptName: "NebulaSans-Book", isCustomFont: true, glyphCount: 1 }] }
      }
      return {}
    }, detach: async () => { events.push("detach") } }
    const page = { evaluateHandle: async () => probe, evaluate: async () => { events.push("zero-load") },
      context: () => ({ newCDPSession: async () => session }) } as unknown as Page
    if (fail) await expect(collectMarketingFontDiagnostic(page, "original62ch")).rejects.toThrow("Font diagnostic")
    else {
      const result = await collectMarketingFontDiagnostic(page, "original62ch")
      expect(result.capturedMaxWidth).toBe("original62ch")
      expect(result.before.maxWidth).toBe("574.856px"); expect(result.after.maxWidth).toBe("556.71px")
    }
    expect(events).toEqual(fail ? ["remove", "dispose", "detach"] : ["zero-load", "remove", "dispose", "detach"])
  }
})
