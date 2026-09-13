import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import { assertProperty, fc } from "../testing/property";
import { HTML_OVERLAY_MAX_DURATION_US, createHtmlOverlayRuntimeFrame } from "./contracts";
import { createHtmlOverlayBrowserRuntimeSource } from "./runtime";
import {
  HtmlOverlayMusicTimingSchema,
  createHtmlOverlayMusicClockRuntimeSource,
  htmlOverlayMusicPulse,
  sampleHtmlOverlayMusicClock,
  type HtmlOverlayMusicSample,
  type HtmlOverlayMusicTiming,
} from "./music-clock";

const FOUR_FOUR = { beatOffsetUs: 0, beatsPerBar: 4, bpm: 120 } as const;
const browser = runInNewContext(createHtmlOverlayMusicClockRuntimeSource(), {
  Date: undefined,
  performance: undefined,
  requestAnimationFrame: undefined,
  setTimeout: undefined,
}) as {
  musicClock: (timeUs: number, timing: unknown) => HtmlOverlayMusicSample;
  musicPulse: (phase: number, widthBeats?: number) => number;
};

function accepted(run: () => unknown): boolean {
  try { run(); return true; } catch { return false; }
}

describe("HTML overlay musical clock", () => {
  test("the complete browser runtime exposes the checked clock to frame callbacks and backward seeks", async () => {
    const canvas = { width: 320, height: 180, deviceScaleFactor: 1 };
    const timing = { durationUs: 1_000_000, fps: 4 };
    const sandbox: Record<string, unknown> = { document: { getAnimations: () => [] }, addEventListener() {} };
    const host = runInNewContext(createHtmlOverlayBrowserRuntimeSource({
      canvas, timing, parameters: {}, resources: [], seed: 42,
    }), sandbox) as { renderFrame: (frame: unknown) => Promise<void> };
    const api = sandbox.SlopcameraOverlay as {
      musicClock: (timeUs: number, timing: HtmlOverlayMusicTiming) => HtmlOverlayMusicSample;
      musicPulse: (phase: number, width?: number) => number;
      onFrame: (callback: (frame: { timeMs: number }) => void) => void;
    };
    const samples: { beat: HtmlOverlayMusicSample; pulse: number }[] = [];
    api.onFrame(({ timeMs }) => {
      const beat = api.musicClock(Math.round(timeMs * 1_000), FOUR_FOUR);
      samples.push({ beat, pulse: api.musicPulse(beat.beatPhase) });
    });
    for (const frame of [0, 3, 1, 0]) {
      await host.renderFrame(createHtmlOverlayRuntimeFrame(frame, canvas, timing));
    }
    expect(samples.map(sample => sample.beat.beatPosition)).toEqual([0, 1.5, 0.5, 0]);
    expect(samples.map(sample => sample.pulse)).toEqual([1, 0, 0, 1]);
    expect(samples[3]).toEqual(samples[0]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(() => api.musicClock(0.1, FOUR_FOUR)).toThrow();
    expect(() => api.musicPulse(1)).toThrow();
  });

  test("requires an explicit strict bounded tempo, offset, and meter", () => {
    expect(HtmlOverlayMusicTimingSchema.parse(FOUR_FOUR)).toEqual(FOUR_FOUR);
    for (const invalid of [
      {}, { bpm: 120 }, { ...FOUR_FOUR, bpm: 19.99 }, { ...FOUR_FOUR, bpm: 400.01 },
      { ...FOUR_FOUR, bpm: Number.NaN }, { ...FOUR_FOUR, bpm: Infinity },
      { ...FOUR_FOUR, bpm: "120" }, { ...FOUR_FOUR, beatsPerBar: 0 },
      { ...FOUR_FOUR, beatsPerBar: 33 }, { ...FOUR_FOUR, beatsPerBar: 3.5 },
      { ...FOUR_FOUR, beatOffsetUs: 0.25 },
      { ...FOUR_FOUR, beatOffsetUs: HTML_OVERLAY_MAX_DURATION_US + 1 },
      { ...FOUR_FOUR, beatOffsetUs: -HTML_OVERLAY_MAX_DURATION_US - 1 },
      { ...FOUR_FOUR, downbeat: true },
    ]) {
      expect(HtmlOverlayMusicTimingSchema.safeParse(invalid).success).toBe(false);
      expect(() => sampleHtmlOverlayMusicClock(0, invalid as HtmlOverlayMusicTiming)).toThrow();
      expect(() => browser.musicClock(0, invalid)).toThrow();
    }
  });

  test("samples beat zero, a quarter beat, and a whole bar without advancing state", () => {
    expect(sampleHtmlOverlayMusicClock(0, FOUR_FOUR)).toEqual({
      barIndex: 0, barPhase: 0, beatIndex: 0, beatPhase: 0, beatPosition: 0,
    });
    expect(sampleHtmlOverlayMusicClock(125_000, FOUR_FOUR)).toEqual({
      barIndex: 0, barPhase: 0.0625, beatIndex: 0, beatPhase: 0.25, beatPosition: 0.25,
    });
    expect(sampleHtmlOverlayMusicClock(2_000_000, FOUR_FOUR)).toEqual({
      barIndex: 1, barPhase: 0, beatIndex: 4, beatPhase: 0, beatPosition: 4,
    });
    expect(Object.isFrozen(sampleHtmlOverlayMusicClock(0, FOUR_FOUR))).toBe(true);
  });

  test("preserves negative pre-roll instead of truncating or clamping it", () => {
    expect(sampleHtmlOverlayMusicClock(-125_000, FOUR_FOUR)).toEqual({
      barIndex: -1, barPhase: 0.9375, beatIndex: -1, beatPhase: 0.75, beatPosition: -0.25,
    });
    expect(sampleHtmlOverlayMusicClock(375_000, { ...FOUR_FOUR, beatOffsetUs: 500_000 }))
      .toEqual(sampleHtmlOverlayMusicClock(-125_000, FOUR_FOUR));
    expect(sampleHtmlOverlayMusicClock(-2_000_000, FOUR_FOUR)).toEqual({
      barIndex: -1, barPhase: 0, beatIndex: -4, beatPhase: 0, beatPosition: -4,
    });
  });

  test("retains one microsecond of slow-tempo pre-roll despite phase rounding", () => {
    const sample = sampleHtmlOverlayMusicClock(0, { beatOffsetUs: 1, beatsPerBar: 1, bpm: 20 });
    expect(sample.beatPosition).toBe(-1 / 3_000_000);
    expect(sample.beatIndex).toBe(-1);
    expect(sample.barIndex).toBe(-1);
    expect(sample.beatPhase).toBeCloseTo(1 - 1 / 3_000_000, 15);
    expect(sample.beatIndex + sample.beatPhase).toBeCloseTo(sample.beatPosition, 12);
    expect(browser.musicClock(0, { beatOffsetUs: 1, beatsPerBar: 1, bpm: 20 })).toEqual(sample);
  });

  test("retains decimal BPM and caller-selected meter without snapping the beat grid", () => {
    const timing = { beatOffsetUs: 312_500, beatsPerBar: 7, bpm: 88.88 };
    const sample = sampleHtmlOverlayMusicClock(30_312_500, timing);
    expect(sample.beatPosition).toBe(44.44);
    expect(sample.beatIndex).toBe(44);
    expect(sample.beatPhase).toBeCloseTo(0.44, 12);
    expect(sample.barIndex).toBe(6);
    expect(sample.barPhase).toBeCloseTo(2.44 / 7, 12);
    expect(sampleHtmlOverlayMusicClock(499_999, FOUR_FOUR).beatIndex).toBe(0);
    expect(sampleHtmlOverlayMusicClock(500_000, FOUR_FOUR).beatIndex).toBe(1);
    expect(sampleHtmlOverlayMusicClock(500_001, FOUR_FOUR).beatIndex).toBe(1);
  });

  test("rejects fractional, nonfinite, and excessive absolute timestamps", () => {
    for (const timeUs of [0.1, -0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER,
      HTML_OVERLAY_MAX_DURATION_US + 1, -HTML_OVERLAY_MAX_DURATION_US - 1]) {
      expect(() => sampleHtmlOverlayMusicClock(timeUs, FOUR_FOUR)).toThrow();
      expect(() => browser.musicClock(timeUs, FOUR_FOUR)).toThrow();
    }
    for (const timeUs of [-HTML_OVERLAY_MAX_DURATION_US, HTML_OVERLAY_MAX_DURATION_US]) {
      expect(sampleHtmlOverlayMusicClock(timeUs, FOUR_FOUR).beatPhase).toBe(0);
    }
    const zero = sampleHtmlOverlayMusicClock(-0, FOUR_FOUR);
    expect(Object.values(zero).every(value => Object.is(value, 0))).toBe(true);
  });
});

describe("HTML overlay musical pulse", () => {
  test("uses a bounded smooth periodic envelope with equal anticipation and decay", () => {
    expect(htmlOverlayMusicPulse(0)).toBe(1);
    expect(htmlOverlayMusicPulse(0.125)).toBe(0.5);
    expect(htmlOverlayMusicPulse(0.875)).toBe(0.5);
    expect(htmlOverlayMusicPulse(0.25)).toBe(0);
    expect(htmlOverlayMusicPulse(0.75)).toBe(0);
    expect(htmlOverlayMusicPulse(0.5)).toBe(0);
    expect(htmlOverlayMusicPulse(0.25, 1)).toBe(0.5);
    expect(htmlOverlayMusicPulse(1 - 1e-8)).toBeCloseTo(1, 12);
    expect(htmlOverlayMusicPulse(1e-8)).toBeCloseTo(1, 12);
  });

  test("rejects invalid phases and widths and remains finite at subnormal widths", () => {
    for (const phase of [-0.1, 1, 10, NaN, Infinity]) {
      expect(() => htmlOverlayMusicPulse(phase)).toThrow();
      expect(() => browser.musicPulse(phase)).toThrow();
    }
    for (const width of [0, -0.1, 1.01, NaN, Infinity]) {
      expect(() => htmlOverlayMusicPulse(0, width)).toThrow();
      expect(() => browser.musicPulse(0, width)).toThrow();
    }
    expect(htmlOverlayMusicPulse(0, Number.MIN_VALUE)).toBe(1);
    expect(htmlOverlayMusicPulse(0.25, Number.MIN_VALUE)).toBe(0);
  });
});

const timingArbitrary = fc.record({
  beatOffsetUs: fc.integer({ min: -HTML_OVERLAY_MAX_DURATION_US, max: HTML_OVERLAY_MAX_DURATION_US }),
  beatsPerBar: fc.integer({ min: 1, max: 32 }),
  bpm: fc.double({ min: 20, max: 400, noNaN: true }),
});

test("musical clock properties: normalized phases, signed decomposition, and browser parity", () => {
  assertProperty(fc.property(
    timingArbitrary,
    fc.integer({ min: -HTML_OVERLAY_MAX_DURATION_US, max: HTML_OVERLAY_MAX_DURATION_US - 1 }),
    (timing, timeUs) => {
      const sample = sampleHtmlOverlayMusicClock(timeUs, timing);
      expect(sample.beatPhase).toBeGreaterThanOrEqual(0);
      expect(sample.beatPhase).toBeLessThan(1);
      expect(sample.barPhase).toBeGreaterThanOrEqual(0);
      expect(sample.barPhase).toBeLessThan(1);
      expect(sample.beatIndex + sample.beatPhase).toBeCloseTo(sample.beatPosition, 9);
      expect(sample.barIndex * timing.beatsPerBar + sample.barPhase * timing.beatsPerBar)
        .toBeCloseTo(sample.beatPosition, 9);
      expect(browser.musicClock(timeUs, timing)).toEqual(sample);
      expect(sampleHtmlOverlayMusicClock(timeUs + 1, timing).beatPosition)
        .toBeGreaterThan(sample.beatPosition);
      sampleHtmlOverlayMusicClock(-timeUs, timing);
      expect(sampleHtmlOverlayMusicClock(timeUs, timing)).toEqual(sample);
    },
  ));
});

test("musical clock properties: translating time and beat zero together preserves the sample", () => {
  assertProperty(fc.property(
    fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    (timeUs, beatOffsetUs, translationUs) => {
      expect(sampleHtmlOverlayMusicClock(timeUs + translationUs, {
        ...FOUR_FOUR, beatOffsetUs: beatOffsetUs + translationUs,
      })).toEqual(sampleHtmlOverlayMusicClock(timeUs, { ...FOUR_FOUR, beatOffsetUs }));
    },
  ));
});

test("music boundary properties: browser and SDK reject the same foreign timing values", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    expect(accepted(() => browser.musicClock(0, value)))
      .toBe(accepted(() => sampleHtmlOverlayMusicClock(0, value as HtmlOverlayMusicTiming)));
  }));
});

test("musical pulse properties: finite bounds and browser parity for every positive width", () => {
  assertProperty(fc.property(
    fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
    fc.double({ min: 0, minExcluded: true, max: 1, noNaN: true }),
    (phase, width) => {
      const pulse = htmlOverlayMusicPulse(phase, width);
      expect(pulse).toBeGreaterThanOrEqual(0);
      expect(pulse).toBeLessThanOrEqual(1);
      expect(browser.musicPulse(phase, width)).toBe(pulse);
    },
  ));
});

test("musical pulse properties: symmetry across exactly representable beat phases", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 1_023 }),
    fc.integer({ min: 1, max: 1_024 }),
    (phaseSteps, widthSteps) => {
      const phase = phaseSteps / 1_024, width = widthSteps / 1_024;
      expect(htmlOverlayMusicPulse(phase, width)).toBe(htmlOverlayMusicPulse(1 - phase, width));
    },
  ));
});
