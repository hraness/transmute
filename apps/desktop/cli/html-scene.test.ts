import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import type { ApplicationContext, ApplicationProcessRunOptions } from "../application/context";
import { bindHtmlOverlayBrowserRuntime } from "../application/html-overlay-browser-runtime";
import { createHtmlOverlayExecutionBundle } from "../application/html-overlay-integrity";
import type { HtmlOverlayFrameRenderRequest } from "../application/html-overlay-renderer";
import { VideoProjectV1Schema } from "../contracts";
import { htmlOverlayFrameCount } from "../html-overlay/contracts";
import { getApprovedHtmlOverlayLibraryLock } from "../html-overlay/libraries";
import { HtmlSceneInputSchema } from "../html-overlay/scene";
import { renderHtmlScene, planHtmlScene, verifyHtmlSceneProbe, type HtmlSceneDependencies } from "./html-scene";
import { ingestProjectMedia } from "./media-ingest";
import { createCliTestHostResourceCoordinator } from "./run-cli-test-helper";

const roots: string[] = [];
const coordinator = createCliTestHostResourceCoordinator(import.meta.url);
const NOW = new Date("2026-09-13T16:00:00.000Z");
const HTML = "<!doctype html><canvas aria-label=\"synthetic color scene\"></canvas>";
const RESOURCE = Buffer.from('{"radius":2,"segments":12}\n');
const LOSSLESS = Buffer.from("controlled encoder fixture: silent lossless scene");
const DELIVERY = Buffer.from("controlled encoder fixture: h264/aac delivery");
const EXPECTED = { width: 32, height: 18, frameCount: 3, durationUs: 1_500_000, audio: true };

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function soundtrack(): Buffer<ArrayBuffer> {
  const dataBytes = 48_000 * 2 * 2 * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF"); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48_000, 24); bytes.writeUInt32LE(192_000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function png(frame: number, width = 32, height = 18): Buffer {
  const crc = (data: Buffer) => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let index = 0; index < 8; index++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, bytes: Buffer) => {
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    const content = Buffer.concat([Buffer.from(type), bytes]);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(content));
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * stride + 1 + x * 4;
    pixels[offset] = 40 + frame * 40; pixels[offset + 1] = x * 5;
    pixels[offset + 2] = y * 10; pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

function finalProbe(audio = true) {
  return {
    format: { duration: "1.500000" },
    streams: [
      { codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", color_range: "tv", color_space: "bt709",
        color_transfer: "bt709", color_primaries: "bt709", width: 32, height: 18, nb_read_frames: "3", start_time: "0.000000", duration: "1.500000" },
      ...(audio ? [{ codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", start_time: "0.000000", duration: "1.500000" }] : []),
    ],
  };
}

function importProbe(audio: boolean) {
  return {
    format: { format_name: audio ? "wav" : "mov,mp4,m4a,3gp,3g2,mj2", duration: audio ? "2.000000" : "1.500000", start_time: "0.000000" },
    streams: audio
      ? [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "48000", duration: "2.000000", start_time: "0.000000" }]
      : [{ index: 0, codec_type: "video", codec_name: "h264", width: 32, height: 18, avg_frame_rate: "2/1", r_frame_rate: "2/1", duration: "1.500000", start_time: "0.000000" }],
  };
}

async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-html-scene-")));
  roots.push(temporary);
  const root = join(temporary, "repository"), privateRoot = join(root, "artifacts/slopcamera/private");
  const projectRoot = join(root, "artifacts/slopcamera/projects"), external = join(temporary, "external");
  const browser = join(root, "tools/Fixture.app/Contents/MacOS/Fixture");
  for (const path of [privateRoot, projectRoot, external, join(root, "inputs"), dirname(browser)]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const toolPaths = { ffmpeg: join(root, "tools/ffmpeg"), ffprobe: join(root, "tools/ffprobe"), "html-browser": browser };
  for (const [name, path] of Object.entries(toolPaths)) {
    await writeFile(path, `#!/bin/sh\n# inert ${name} fixture; injected runner owns all effects\nexit 0\n`, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  await writeFile(join(root, "inputs/scene.html"), HTML);
  await writeFile(join(root, "inputs/geometry.json"), RESOURCE);
  const audioPath = join(external, "original soundtrack.wav"), originalAudio = soundtrack();
  await writeFile(audioPath, originalAudio);
  const input = HtmlSceneInputSchema.parse({
    kind: "slopcamera.html-scene", schemaVersion: 1, name: "Synthetic scene",
    document: { path: "inputs/scene.html" },
    canvas: { width: 32, height: 18, deviceScaleFactor: 1 }, timing: { durationUs: 1_050_000, fps: 2 },
    resources: [{ name: "geometry", path: "inputs/geometry.json", urlPath: "assets/geometry.json", mediaType: "application/json", transport: "fetch" }],
    parameters: { music: { bpm: 88.88, beatOffsetUs: 0, beatsPerBar: 4 } },
    audio: { path: audioPath },
  });
  const state = {
    browserCalls: 0, renderCalls: 0, leaseChecks: 0, encodeCalls: 0,
    leaseLost: false, failEncode: 0, cancelAfterEncode: 0,
    leaseLostOnFrames: false, mutateFramesAfterEncode: false,
    mutateRetainedAfterDelivery: "" as "" | "video" | "audio" | "document" | "resource" | "intent" | "frames",
    mutateOutputDuringProjectImport: false,
    frameFault: "" as "" | "integrity" | "libraries" | "path" | "count" | "dimensions" | "symlink",
    changeEncoderOnFrames: false,
    probe: finalProbe(),
    soundtrackProbe: importProbe(true),
    stages: [] as string[],
    calls: [] as { argv: readonly string[]; options: ApplicationProcessRunOptions | undefined }[],
    renderRequests: [] as HtmlOverlayFrameRenderRequest[],
  };
  const controller = new AbortController();
  const capabilities = Object.entries(toolPaths).map(([name, command]) => ({
    available: true, command, name: name as "ffmpeg" | "ffprobe" | "html-browser", version: `physical-${name}-fixture`,
  }));
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, desktopRoot: root, privateRoot, projectRoot, artifactRoot: join(root, "artifacts/slopcamera/recordings") },
    machineStateRoot: join(temporary, "machine"),
    clock: { now: () => NOW, timestampMilliseconds: () => NOW.getTime() },
    capabilities: async () => capabilities,
    capability: async name => capabilities.find(item => item.name === name) ?? { name, available: false },
    runner: {
      run: async (argv, options) => {
        state.calls.push({ argv, options });
        // Real exact-capability pinning still runs before this controlled port.
        expect(argv[0]).toContain("capability-pins-v1");
        expect(options?.abortSignal).toBe(controller.signal);
        expect(options?.inheritedFileDescriptors).toEqual([]);
        if (basename(argv[0]) === "ffprobe") {
          const deliveryProbe = argv.includes("-count_frames");
          const soundtrackSource = !deliveryProbe && (await readFile(argv.at(-1)!)).subarray(0, 4).toString() === "RIFF";
          const data = deliveryProbe ? state.probe : soundtrackSource ? state.soundtrackProbe : importProbe(false);
          if (!deliveryProbe && !soundtrackSource && state.mutateOutputDuringProjectImport) {
            await writeFile(join(dirname(state.renderRequests[0]!.outputDirectory), "video.mp4"), "changed delivery after its probe and hash");
          }
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(data) };
        }
        state.encodeCalls++;
        if (state.failEncode === state.encodeCalls) return { exitCode: 9, stderr: "controlled encoder failure", stdout: "" };
        await writeFile(argv.at(-1)!, state.encodeCalls === 1 ? LOSSLESS : DELIVERY, { mode: 0o600 });
        if (state.mutateFramesAfterEncode && state.encodeCalls === 1) {
          await writeFile(join(state.renderRequests[0]!.outputDirectory, "frames/frame-00000000.png"), png(5));
        }
        if (state.mutateRetainedAfterDelivery !== "" && state.encodeCalls === 2) {
          const inputs = argv.flatMap((argument, index) => argument === "-i" ? [argv[index + 1]!] : []);
          const target = state.mutateRetainedAfterDelivery === "video" ? inputs[0]!
            : state.mutateRetainedAfterDelivery === "audio" ? inputs[1]!
              : state.mutateRetainedAfterDelivery === "document" ? join(dirname(argv.at(-1)!), "source/scene.html")
                : state.mutateRetainedAfterDelivery === "intent" ? join(dirname(argv.at(-1)!), "intent.json")
                  : state.mutateRetainedAfterDelivery === "frames" ? join(dirname(argv.at(-1)!), "frames.json")
                    : state.renderRequests[0]!.resources[0]!.absolutePath;
          await writeFile(target, "changed retained input during delivery encoding");
        }
        if (state.cancelAfterEncode === state.encodeCalls) controller.abort();
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    },
    htmlOverlayRenderer: {
      renderFrames: async request => {
        state.renderCalls++; state.renderRequests.push(request);
        const bundle = createHtmlOverlayExecutionBundle(request.authoring, request.browserRuntime, request.executionProfile);
        const frameCount = htmlOverlayFrameCount(request.authoring.timing);
        const framesDirectory = join(request.outputDirectory, "frames");
        await mkdir(framesDirectory, { mode: 0o700 });
        for (let frame = 0; frame < frameCount; frame++) {
          const framePath = join(framesDirectory, `frame-${String(frame).padStart(8, "0")}.png`);
          if (state.frameFault === "symlink" && frame === 0) {
            const foreignFrame = join(external, "foreign-frame.png");
            await writeFile(foreignFrame, png(frame), { mode: 0o600 });
            await symlink(foreignFrame, framePath);
          } else {
            await writeFile(framePath, png(frame, state.frameFault === "dimensions" ? 30 : 32), { mode: 0o600 });
          }
        }
        if (state.changeEncoderOnFrames) await writeFile(toolPaths.ffmpeg, "#!/bin/sh\n# replaced after binding\nexit 8\n");
        if (state.leaseLostOnFrames) state.leaseLost = true;
        return {
          executionIntegrity: state.frameFault === "integrity" ? { ...bundle.integrity, rootSha256: "f".repeat(64) } : bundle.integrity,
          libraryLocks: state.frameFault === "libraries" ? [getApprovedHtmlOverlayLibraryLock("three")] : bundle.libraryLocks,
          frameCount: state.frameFault === "count" ? frameCount + 1 : frameCount,
          framePattern: join(state.frameFault === "path" ? external : framesDirectory, "frame-%08d.png"),
        };
      },
    },
  };
  const dependencies: HtmlSceneDependencies = {
    bindBrowser: async (binding, signal) => {
      state.browserCalls++;
      return await bindHtmlOverlayBrowserRuntime(binding, signal, { allowUnverifiedRuntimeForTesting: true });
    },
    progress: stage => state.stages.push(stage),
  };
  const render = async (request: unknown = input, patch: Partial<ApplicationContext> = {}) =>
    await coordinator.withLease([{ resource: "cpu", amount: 1 }], async lease => {
      const hostResourceLease = { ...lease, inheritedFileDescriptors: [], assertOwned: async () => {
        state.leaseChecks++;
        if (state.leaseLost) throw new Error("fixture host lease lost");
        await lease.assertOwned();
      } };
      return await renderHtmlScene({ ...application, hostResourceLease, ...patch }, request, controller.signal, dependencies);
    });
  return { root, temporary, external, projectRoot, input, audioPath, originalAudio, state, controller, application, dependencies, render };
}

describe("HTML scene export", () => {
  test("dry planning bounds source work and reports frame rounding without capabilities or rendering", async () => {
    const f = await fixture();
    const plan = await planHtmlScene(f.application, f.input, f.controller.signal);
    expect(plan).toMatchObject({ executed: false, frameCount: 3, durationUs: 1_500_000,
      requestedDurationUs: 1_050_000, width: 32, height: 18, audioValidated: false,
      timingPolicy: "ceil-frames-trim-or-pad-audio-v1" });
    expect(f.state.browserCalls).toBe(0); expect(f.state.renderCalls).toBe(0); expect(f.state.calls).toHaveLength(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
  });

  test("retains checked sources and publishes separate editable original-audio and silent-video assets", async () => {
    const f = await fixture();
    const result = await f.render({ ...f.input, background: "#123456" });
    const retainedBytes = await readFile(join(f.root, result.source.path));
    const retained = HtmlSceneInputSchema.parse(JSON.parse(retainedBytes.toString()));
    expect("path" in retained.document).toBe(true);
    if (!("path" in retained.document)) throw new Error("Expected a retained source path.");
    expect(await readFile(join(f.root, retained.document.path), "utf8")).toBe(HTML);
    expect(await readFile(join(f.root, retained.resources[0]!.path))).toEqual(RESOURCE);
    expect(retained.resources[0]?.transport).toBe("fetch");
    expect(retained.parameters).toEqual(f.input.parameters);
    expect(retained.background).toBe("#123456");
    expect(result.source.sha256).toBe(sha256(retainedBytes));
    expect(await readFile(join(f.root, retained.audio!.path))).toEqual(f.originalAudio);
    expect(await readFile(f.audioPath)).toEqual(f.originalAudio);
    expect(await readFile(join(f.root, result.output.path))).toEqual(DELIVERY);
    expect(result.output.sha256).toBe(sha256(DELIVERY));
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, result.projectPath), "utf8")));
    expect(project.assets).toHaveLength(2);
    expect(project.timeline.durationUs).toBe(1_500_000);
    const video = project.assets.find(asset => asset.role === "screen")!;
    const audio = project.assets.find(asset => asset.role === "music")!;
    expect(video.source.kind).toBe("generated");
    const intent = await readFile(join(dirname(join(f.root, result.source.path)), "intent.json"));
    expect(JSON.parse(intent.toString())).toMatchObject({ source: result.source });
    expect(video.source).toMatchObject({ sourceSha256: sha256(intent) });
    expect(video.streams.map(stream => stream.kind)).toEqual(["video"]);
    expect(audio.streams.map(stream => stream.kind)).toEqual(["audio"]);
    expect(audio.durationUs).toBe(2_000_000);
    expect(await readFile(join(f.root, video.streams[0]!.segments[0]!.path))).toEqual(LOSSLESS);
    expect(await readFile(join(f.root, audio.streams[0]!.segments[0]!.path))).toEqual(f.originalAudio);
    expect(project.placements.find(item => item.assetId === audio.assetId)?.assetRange).toEqual({ startUs: 0, endUs: 1_500_000 });
    if (project.currentEditPlanPath === null) throw new Error("Expected an editable project plan.");
    expect(existsSync(join(dirname(join(f.root, result.projectPath)), project.currentEditPlanPath))).toBe(true);
    expect(f.state.stages.at(-1)).toBe("complete");
    expect(f.state.leaseChecks).toBeGreaterThan(10);
    await writeFile(join(f.root, "inputs/geometry.json"), "changed original source");
    expect(await readFile(join(f.root, retained.resources[0]!.path))).toEqual(RESOURCE);
  });

  test("supersampling preserves the renderer's CSS screenshot and exported project dimensions", async () => {
    const f = await fixture();
    const input = { ...f.input, canvas: { ...f.input.canvas, deviceScaleFactor: 2 } };
    const plan = await planHtmlScene(f.application, input, f.controller.signal);
    expect(plan).toMatchObject({ width: 32, height: 18 });
    const result = await f.render(input);
    expect(f.state.renderRequests[0]?.authoring.canvas).toEqual(input.canvas);
    expect(result.verification).toMatchObject({ width: 32, height: 18 });
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, result.projectPath), "utf8")));
    expect(project.assets.find(asset => asset.role === "screen")?.streams[0]).toMatchObject({ pixelWidth: 32, pixelHeight: 18 });
  });

  test("rejects foreign or symlinked browser resources before binding capabilities", async () => {
    const f = await fixture();
    await symlink(f.audioPath, join(f.root, "inputs/alias.bin"));
    for (const path of ["../outside.bin", f.audioPath, "inputs/alias.bin"]) {
      await expect(f.render({ ...f.input, resources: [{ ...f.input.resources[0], path }] })).rejects.toThrow();
    }
    expect(f.state.browserCalls).toBe(0); expect(f.state.renderCalls).toBe(0); expect(f.state.calls).toHaveLength(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
  });

  test("rejects a symlinked soundtrack and preserves the caller-owned file", async () => {
    const f = await fixture(), alias = join(f.external, "soundtrack-alias.wav");
    await symlink(f.audioPath, alias);
    await expect(f.render({ ...f.input, audio: { path: alias } })).rejects.toThrow(/physical|symbolic|symlink/iu);
    expect(await readFile(f.audioPath)).toEqual(f.originalAudio);
    expect(f.state.renderCalls).toBe(0); expect(f.state.encodeCalls).toBe(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
  });

  test("rejects delayed soundtrack streams before rendering or encoding", async () => {
    const f = await fixture();
    f.state.soundtrackProbe.streams[0]!.start_time = "0.200000";
    await expect(f.render()).rejects.toThrow(/zero|origin|start/iu);
    expect(f.state.renderCalls).toBe(0); expect(f.state.encodeCalls).toBe(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
    expect(await readFile(f.audioPath)).toEqual(f.originalAudio);
  });

  test("requires a live admitted lease and rejects cancellation before touching capabilities", async () => {
    const f = await fixture();
    await expect(renderHtmlScene(f.application, f.input, f.controller.signal, f.dependencies))
      .rejects.toThrow(/host-resource lease/u);
    f.state.leaseLost = true;
    await expect(f.render()).rejects.toThrow(/host lease lost/u);
    f.state.leaseLost = false; f.controller.abort();
    await expect(f.render()).rejects.toThrow(/cancelled/u);
    expect(f.state.browserCalls).toBe(0); expect(f.state.calls).toHaveLength(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
  });

  test("cancellation after an encode stops publication and subsequent subprocesses", async () => {
    const f = await fixture(); f.state.cancelAfterEncode = 1;
    await expect(f.render()).rejects.toThrow(/cancelled/u);
    expect(f.state.encodeCalls).toBe(1);
    expect(await readdir(f.projectRoot)).toEqual([]);
    expect(f.state.stages).not.toContain("complete");
  });

  test("loss of the admitted host lease during rendering fences off encoding and publication", async () => {
    const f = await fixture(); f.state.leaseLostOnFrames = true;
    await expect(f.render()).rejects.toThrow(/host lease lost/u);
    expect(f.state.renderCalls).toBe(1); expect(f.state.encodeCalls).toBe(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
  });

  test("failed first or delivery encodes retain sources but publish no editable project", async () => {
    for (const failEncode of [1, 2]) {
      const f = await fixture(); f.state.failEncode = failEncode;
      await expect(f.render()).rejects.toThrow(/controlled encoder failure/u);
      expect(f.state.encodeCalls).toBe(failEncode);
      expect(await readdir(f.projectRoot)).toEqual([]);
      const jobs = await readdir(join(f.root, "artifacts/slopcamera/generated/html-scenes"));
      expect(jobs).toHaveLength(1);
      expect(await readFile(join(f.root, "artifacts/slopcamera/generated/html-scenes", jobs[0]!, "source/scene.html"), "utf8")).toBe(HTML);
      expect(f.state.stages).not.toContain("complete");
    }
  });

  test("a replaced exact encoder binding cannot reach the process runner", async () => {
    const f = await fixture(); f.state.changeEncoderOnFrames = true;
    await expect(f.render()).rejects.toThrow(/changed|binding|metadata/iu);
    expect(f.state.encodeCalls).toBe(0);
    expect(await readdir(f.projectRoot)).toEqual([]);
  });

  test("unverified frame counts, execution roots, libraries, or foreign paths cannot be encoded", async () => {
    for (const frameFault of ["count", "integrity", "libraries", "path", "dimensions", "symlink"] as const) {
      const f = await fixture(); f.state.frameFault = frameFault;
      await expect(f.render()).rejects.toThrow();
      expect(f.state.encodeCalls).toBe(0);
      expect(await readdir(f.projectRoot)).toEqual([]);
    }
  });

  test("frame mutation during encoding cannot inherit the earlier source verification", async () => {
    const f = await fixture(); f.state.mutateFramesAfterEncode = true;
    await expect(f.render()).rejects.toThrow(/changed|frame|integrity/iu);
    expect(f.state.encodeCalls).toBe(1);
    expect(await readdir(f.projectRoot)).toEqual([]);
    expect(f.state.stages).not.toContain("complete");
  });

  test("retained video and soundtrack mutation during delivery cannot publish mismatched editable assets", async () => {
    for (const target of ["video", "audio"] as const) {
      const f = await fixture(); f.state.mutateRetainedAfterDelivery = target;
      await expect(f.render()).rejects.toThrow(/changed|byte|hash|integrity|match/iu);
      expect(f.state.encodeCalls).toBe(2);
      expect(await readdir(f.projectRoot)).toEqual([]);
      expect(await readFile(f.audioPath)).toEqual(f.originalAudio);
      expect(f.state.stages).not.toContain("complete");
    }
  });

  test("retained source or receipt mutation cannot publish a bundle inconsistent with the render", async () => {
    for (const target of ["document", "resource", "intent", "frames"] as const) {
      const f = await fixture(); f.state.mutateRetainedAfterDelivery = target;
      await expect(f.render()).rejects.toThrow(/changed|byte|hash|integrity|match/iu);
      expect(f.state.encodeCalls).toBe(2);
      expect(await readdir(f.projectRoot)).toEqual([]);
      expect(f.state.stages).not.toContain("complete");
    }
  });

  test("delivery mutation during editable-video import cannot publish the earlier verification", async () => {
    const f = await fixture(); f.state.mutateOutputDuringProjectImport = true;
    await expect(f.render()).rejects.toThrow(/changed|byte|hash|integrity|match/iu);
    expect(f.state.encodeCalls).toBe(2);
    expect(await readdir(f.projectRoot)).toEqual([]);
    expect(f.state.stages).not.toContain("complete");
  });

  test("a final verification failure cannot publish a project even after successful encodes", async () => {
    const f = await fixture(); f.state.probe.streams[0]!.nb_read_frames = "2";
    await expect(f.render()).rejects.toThrow(/verification/u);
    expect(f.state.encodeCalls).toBe(2);
    expect(await readdir(f.projectRoot)).toEqual([]);
    expect(f.state.stages).not.toContain("project");
  });
});

describe("HTML scene final media verification", () => {
  test("accepts exact video/audio properties and explicitly silent deliveries", () => {
    expect(verifyHtmlSceneProbe(finalProbe(), EXPECTED)).toMatchObject({ frameCount: 3, durationUs: 1_500_000,
      audio: { codec: "aac", channels: 2, sampleRateHz: 48_000, startTimeUs: 0 } });
    expect(verifyHtmlSceneProbe(finalProbe(false), { ...EXPECTED, audio: false }).audio).toBeNull();
  });

  test("rejects incorrect streams, missing frames, timing, dimensions, and audio layout", () => {
    const cases = [
      { ...finalProbe(), format: { duration: "NaN" } },
      { ...finalProbe(), format: { duration: "0.5" } },
      { ...finalProbe(), streams: finalProbe().streams.slice(0, 1) },
      { ...finalProbe(), streams: [finalProbe().streams[0], { ...finalProbe().streams[1], channels: 1 }] },
      { ...finalProbe(), streams: [finalProbe().streams[0], { ...finalProbe().streams[1], start_time: "0.2" }] },
      { ...finalProbe(), streams: [{ ...finalProbe().streams[0], width: 30 }, finalProbe().streams[1]] },
      { ...finalProbe(), streams: [{ ...finalProbe().streams[0], codec_name: "vp9" }, finalProbe().streams[1]] },
      { ...finalProbe(), streams: [{ ...finalProbe().streams[0], nb_read_frames: "2" }, finalProbe().streams[1]] },
    ];
    for (const value of cases) expect(() => verifyHtmlSceneProbe(value, EXPECTED)).toThrow();
  });

  test("container duration cannot conceal a truncated soundtrack or delayed video", () => {
    for (const streams of [
      [finalProbe().streams[0], { ...finalProbe().streams[1], duration: "0.2" }],
      [{ ...finalProbe().streams[0], start_time: "0.4" }, finalProbe().streams[1]],
      [{ ...finalProbe().streams[0], duration: "NaN" }, finalProbe().streams[1]],
    ]) expect(() => verifyHtmlSceneProbe({ ...finalProbe(), streams }, EXPECTED)).toThrow();
  });

  test("requires explicit delivery pixel format, range, and BT.709 color metadata", () => {
    const wrong = { pix_fmt: "yuv444p", color_range: "pc", color_space: "gbr", color_transfer: "iec61966-2-1", color_primaries: "bt2020" };
    for (const [field, value] of Object.entries(wrong)) {
      for (const replacement of [undefined, value]) {
        const probe = finalProbe();
        const video = { ...probe.streams[0], [field]: replacement };
        expect(() => verifyHtmlSceneProbe({ ...probe, streams: [video, ...probe.streams.slice(1)] }, EXPECTED)).toThrow(/verification/u);
      }
    }
  });
});

test("scene-sized media import limits reject oversized sources before probing or copying", async () => {
  const f = await fixture();
  const projectDirectory = join(f.root, "bounded-import");
  await mkdir(projectDirectory, { mode: 0o700 });
  let probes = 0;
  await expect(ingestProjectMedia({
    ffprobe: "never-executed", now: NOW, projectDirectory, repositoryRoot: f.root,
    role: "music", sourcePath: f.audioPath, maximumBytes: 64,
    runner: { run: async () => { probes++; throw new Error("Probe must remain unreachable."); } },
  })).rejects.toThrow(/1 through 64 bytes/u);
  expect(probes).toBe(0);
  expect(await readdir(projectDirectory)).toEqual([]);
  expect(await readFile(f.audioPath)).toEqual(f.originalAudio);
});
