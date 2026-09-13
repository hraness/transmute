import { describe, expect, test } from "bun:test";

import { assertProperty, fc } from "../testing/property";
import { HTML_OVERLAY_MAX_DURATION_US } from "./contracts";
import { HtmlSceneInputSchema } from "./scene";

const source = {
  kind: "slopcamera.html-scene",
  schemaVersion: 1,
  name: "Water and light",
  document: { html: "<!doctype html><canvas></canvas>" },
  canvas: { width: 320, height: 180, deviceScaleFactor: 1 },
  timing: { durationUs: 1_050_000, fps: 30 },
} as const;

const resource = {
  name: "geometry",
  path: "inputs/geometry.json",
  urlPath: "assets/geometry.json",
  mediaType: "application/json",
  transport: "fetch",
} as const;

describe("HTML scene source admission", () => {
  test("keeps explicit audio separate from browser resources and supplies only mechanical defaults", () => {
    expect(HtmlSceneInputSchema.parse(source)).toEqual({
      ...source, background: "#080b16", libraries: [], parameters: {}, resources: [], seed: 0,
    });
    const parsed = HtmlSceneInputSchema.parse({
      ...source,
      resources: [resource],
      audio: { path: "/caller-selected/Music/original.wav" },
      parameters: { music: { bpm: 88.88, beatOffsetUs: 125_000, beatsPerBar: 4 } },
    });
    expect(parsed.audio?.path).toBe("/caller-selected/Music/original.wav");
    expect(parsed.resources).toEqual([resource]);
    expect(parsed.parameters.music).toEqual({ bpm: 88.88, beatOffsetUs: 125_000, beatsPerBar: 4 });
  });

  test("rejects foreign document/resource paths and ambiguous or undeclared source fields", () => {
    for (const path of ["/outside/scene.html", "../scene.html", "inputs/../../scene.html", "inputs\\scene.html", "inputs/scene.html\0"]) {
      expect(HtmlSceneInputSchema.safeParse({ ...source, document: { path } }).success).toBe(false);
      expect(HtmlSceneInputSchema.safeParse({ ...source, resources: [{ ...resource, path }] }).success).toBe(false);
    }
    for (const input of [
      { ...source, document: { path: "scene.html", html: "<p>ambiguous</p>" } },
      { ...source, document: { url: "https://example.test/scene.html" } },
      { ...source, schemaVersion: 2 },
      { ...source, name: "   " },
      { ...source, audio: { path: "track.wav", inferTempo: true } },
      { ...source, audio: { path: "track\n.wav" } },
      { ...source, background: "red;movie=http://example.test" },
      { ...source, resources: [{ ...resource, sha256: "a".repeat(64) }] },
      { ...source, command: "render-anything" },
    ]) expect(HtmlSceneInputSchema.safeParse(input).success).toBe(false);
  });

  test("requires even CSS screenshot dimensions and preserves authoring workload limits", () => {
    for (const canvas of [
      { width: 319, height: 180, deviceScaleFactor: 1 },
      { width: 320, height: 181, deviceScaleFactor: 1 },
      { width: 319, height: 181, deviceScaleFactor: 2 },
    ]) expect(HtmlSceneInputSchema.safeParse({ ...source, canvas }).success).toBe(false);
    for (const canvas of [
      { width: 320, height: 180, deviceScaleFactor: 0.5 },
      { width: 322, height: 180, deviceScaleFactor: 0.75 },
      { width: 320, height: 180, deviceScaleFactor: 2 },
    ]) expect(HtmlSceneInputSchema.safeParse({ ...source, canvas }).success).toBe(true);
    for (const timing of [
      { durationUs: 0, fps: 30 },
      { durationUs: 1.5, fps: 30 },
      { durationUs: HTML_OVERLAY_MAX_DURATION_US + 1, fps: 1 },
      { durationUs: HTML_OVERLAY_MAX_DURATION_US, fps: 120 },
      { durationUs: 1_000_000, fps: 121 },
    ]) expect(HtmlSceneInputSchema.safeParse({ ...source, timing }).success).toBe(false);
    expect(HtmlSceneInputSchema.safeParse({
      ...source,
      canvas: { width: 4_096, height: 2_160, deviceScaleFactor: 1 },
      timing: { durationUs: HTML_OVERLAY_MAX_DURATION_US, fps: 60 },
    }).success).toBe(false);
  });
});

test("scene identity property: one logical resource cannot name two different files", () => {
  assertProperty(fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/u), name => {
    const one = { ...resource, name };
    expect(HtmlSceneInputSchema.safeParse({ ...source, resources: [one] }).success).toBe(true);
    expect(HtmlSceneInputSchema.safeParse({
      ...source,
      resources: [one, { ...one, path: "inputs/other.json", urlPath: "assets/other.json" }],
    }).success).toBe(false);
  }));
});

test("scene boundary property: arbitrary foreign JSON cannot escape the bounded source contract", () => {
  assertProperty(fc.property(fc.jsonValue(), value => {
    const result = HtmlSceneInputSchema.safeParse(value);
    if (!result.success) return;
    const { canvas, timing, resources } = result.data;
    expect(canvas.width % 2).toBe(0);
    expect(canvas.height % 2).toBe(0);
    expect(timing.durationUs).toBeGreaterThan(0);
    expect(timing.durationUs).toBeLessThanOrEqual(HTML_OVERLAY_MAX_DURATION_US);
    expect(new Set(resources.map(item => item.name)).size).toBe(resources.length);
  }));
});
