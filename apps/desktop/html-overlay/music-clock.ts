import { z } from "zod";

import { HTML_OVERLAY_MAX_DURATION_US } from "./contracts";

const MUSIC_CLOCK_LIMITS = Object.freeze({
  maxBeatsPerBar: 32,
  maxBpm: 400,
  maxTimeUs: HTML_OVERLAY_MAX_DURATION_US,
  minBeatsPerBar: 1,
  minBpm: 20,
});

/** Explicit constant tempo and the absolute project time of beat zero. */
export const HtmlOverlayMusicTimingSchema = z.strictObject({
  beatOffsetUs: z.number().int().safe()
    .min(-MUSIC_CLOCK_LIMITS.maxTimeUs).max(MUSIC_CLOCK_LIMITS.maxTimeUs),
  beatsPerBar: z.number().int().safe()
    .min(MUSIC_CLOCK_LIMITS.minBeatsPerBar).max(MUSIC_CLOCK_LIMITS.maxBeatsPerBar),
  bpm: z.number().finite().min(MUSIC_CLOCK_LIMITS.minBpm).max(MUSIC_CLOCK_LIMITS.maxBpm),
});
export type HtmlOverlayMusicTiming = Readonly<z.infer<typeof HtmlOverlayMusicTimingSchema>>;

export type HtmlOverlayMusicSample = Readonly<{
  /** Zero-based signed bar index; pre-roll bars have negative indices. */
  barIndex: number;
  /** Normalized position within the bar, in [0, 1). */
  barPhase: number;
  /** Zero-based signed beat index, rounded toward negative infinity. */
  beatIndex: number;
  /** Normalized position within the beat, in [0, 1). */
  beatPhase: number;
  /** Signed elapsed beats since the explicitly supplied beat-zero offset. */
  beatPosition: number;
}>;

type MusicClockRuntime = Readonly<{
  musicClock: (timeUs: number, timing: unknown) => HtmlOverlayMusicSample;
  musicPulse: (beatPhase: number, widthBeats?: number) => number;
}>;

/** This closure is self-contained so the browser and SDK execute the same code. */
function createMusicClockRuntime(limits: typeof MUSIC_CLOCK_LIMITS): MusicClockRuntime {
  const checkTimeUs = (timeUs: unknown): timeUs is number => (
    typeof timeUs === "number"
    && Number.isSafeInteger(timeUs)
    && Math.abs(timeUs) <= limits.maxTimeUs
  );

  const musicClock = (timeUs: number, timing: unknown): HtmlOverlayMusicSample => {
    if (!checkTimeUs(timeUs)) {
      throw new RangeError(`HTML overlay music timeUs must be an integer within ±${String(limits.maxTimeUs)} microseconds.`);
    }
    if (timing === null || typeof timing !== "object" || Array.isArray(timing)) {
      throw new TypeError("HTML overlay music timing must be an object with bpm, beatOffsetUs, and beatsPerBar.");
    }
    for (const key in timing) {
      if (key !== "bpm" && key !== "beatOffsetUs" && key !== "beatsPerBar") {
        throw new TypeError(`Unknown HTML overlay music timing field ${key}.`);
      }
    }
    const { bpm, beatOffsetUs, beatsPerBar } = timing as Record<string, unknown>;
    if (typeof bpm !== "number" || !Number.isFinite(bpm)
      || bpm < limits.minBpm || bpm > limits.maxBpm) {
      throw new RangeError(`HTML overlay music bpm must be between ${String(limits.minBpm)} and ${String(limits.maxBpm)}.`);
    }
    if (!checkTimeUs(beatOffsetUs)) {
      throw new RangeError(`HTML overlay music beatOffsetUs must be an integer within ±${String(limits.maxTimeUs)} microseconds.`);
    }
    if (typeof beatsPerBar !== "number" || !Number.isSafeInteger(beatsPerBar)
      || beatsPerBar < limits.minBeatsPerBar || beatsPerBar > limits.maxBeatsPerBar) {
      throw new RangeError(`HTML overlay music beatsPerBar must be an integer between ${String(limits.minBeatsPerBar)} and ${String(limits.maxBeatsPerBar)}.`);
    }

    // Keep the continuous clock unquantized; floor gives consistent pre-roll.
    // Canonicalize negative zero without changing any nonzero beat position.
    const beatPosition = ((timeUs - beatOffsetUs) * bpm) / 60_000_000 || 0;
    const beatIndex = Math.floor(beatPosition);
    const beatPhase = beatPosition - beatIndex;
    const barIndex = Math.floor(beatIndex / beatsPerBar);
    const barPhase = (beatIndex - barIndex * beatsPerBar + beatPhase) / beatsPerBar;
    return Object.freeze({ barIndex, barPhase, beatIndex, beatPhase, beatPosition });
  };

  const musicPulse = (beatPhase: number, widthBeats = 0.5): number => {
    if (!Number.isFinite(beatPhase) || beatPhase < 0 || beatPhase >= 1) {
      throw new RangeError("HTML overlay music beatPhase must be in [0, 1).");
    }
    if (!Number.isFinite(widthBeats) || widthBeats <= 0 || widthBeats > 1) {
      throw new RangeError("HTML overlay music pulse widthBeats must be in (0, 1].");
    }
    const distance = Math.min(beatPhase, 1 - beatPhase);
    // Divide before doubling so even a positive subnormal width stays defined.
    const position = Math.min(1, (distance / widthBeats) * 2);
    return 1 - position * position * (3 - 2 * position);
  };

  return Object.freeze({ musicClock, musicPulse });
}

const musicRuntime = createMusicClockRuntime(MUSIC_CLOCK_LIMITS);

/** Samples absolute integer project time. This does not detect tempo or downbeats. */
export function sampleHtmlOverlayMusicClock(
  timeUs: number,
  timing: HtmlOverlayMusicTiming,
): HtmlOverlayMusicSample {
  // Validate the original value with the shared browser boundary as well as the
  // public schema; neither path silently strips an undeclared timing field.
  const sample = musicRuntime.musicClock(timeUs, timing);
  HtmlOverlayMusicTimingSchema.parse(timing);
  return sample;
}

/**
 * A periodic [0, 1] smoothstep pulse centered on each beat. widthBeats is the
 * complete nonzero width, with equal anticipation and decay. Both the beat seam
 * and the support edges have zero slope. This is an envelope, not flash analysis.
 */
export function htmlOverlayMusicPulse(beatPhase: number, widthBeats = 0.5): number {
  return musicRuntime.musicPulse(beatPhase, widthBeats);
}

/** Internal browser integration: a complete expression with musicClock/musicPulse. */
export function createHtmlOverlayMusicClockRuntimeSource(): string {
  return `(${createMusicClockRuntime.toString()})(${JSON.stringify(MUSIC_CLOCK_LIMITS)})`;
}
