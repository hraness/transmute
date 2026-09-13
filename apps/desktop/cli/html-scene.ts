import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ApplicationContext } from "../application/context";
import {
  bindExactCapabilities, ExactCapabilityApplicationRunner,
  type ExactCapabilityBinding,
} from "../application/capability-binding";
import { bindHtmlOverlayBrowserRuntime } from "../application/html-overlay-browser-runtime";
import { assertHtmlOverlayExecutionProfileLibraries, createHtmlOverlayExecutionBundle, HtmlOverlayExecutionIntegritySchema } from "../application/html-overlay-integrity";
import {
  loadRepositoryMedia, type MediaArtifactReference,
} from "../application/operations/media/shared";
import {
  ProjectAssetV1Schema, ProjectEditPlanV1Schema, ProjectPlacementV1Schema, VideoProjectV1Schema,
  type ProjectAssetV1,
} from "../contracts";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import { createDefaultProjectEditPlan } from "../core/project-plan";
import { createNodeBundleFileSystem } from "../core/storage";
import {
  HTML_OVERLAY_MAX_HTML_BYTES, HTML_OVERLAY_MAX_RESOURCE_BYTES,
  HTML_OVERLAY_MAX_TOTAL_RESOURCE_BYTES, HtmlOverlayAuthoringInputSchema,
  htmlOverlayFrameCount,
} from "../html-overlay/contracts";
import { HtmlSceneInputSchema } from "../html-overlay/scene";
import { HtmlOverlayActiveLibraryLocksSchema, getApprovedHtmlOverlayLibraryLock } from "../html-overlay/libraries";
import { assertHtmlOverlayGpuEvidenceProfile } from "../html-overlay/execution-profile";
import { CliError } from "./errors";
import { ingestProjectMedia, SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS } from "./media-ingest";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";
import { readSpatialJson } from "./spatial-scene-service";

const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 5 * 60_000;

export type HtmlSceneStage = "source" | "browser" | "frames" | "encode" | "verify" | "project" | "complete";
export interface HtmlSceneDependencies {
  /** Internal controlled-test seams; invocation input cannot replace host capabilities. */
  readonly bindBrowser?: typeof bindHtmlOverlayBrowserRuntime;
  readonly bindTools?: typeof bindExactCapabilities;
  readonly progress?: (stage: HtmlSceneStage) => void;
}

async function readPngHeader(path: string, expectedBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedBytes)) throw new CliError("conflict", "Scene frame changed before header validation.");
    const header = Buffer.alloc(Math.min(33, expectedBytes));
    const read = await handle.read(header, 0, header.length, 0);
    const after = await handle.stat({ bigint: true });
    if (read.bytesRead !== header.length || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new CliError("conflict", "Scene frame changed during header validation.");
    }
    return header;
  } finally { await handle.close(); }
}

async function readSource(application: ApplicationContext, input: unknown, signal: AbortSignal) {
  const request = HtmlSceneInputSchema.parse(input);
  assertHtmlOverlayExecutionProfileLibraries(request.libraries, request.executionProfile);
  const loadedDocument = "path" in request.document
    ? await loadRepositoryMedia(application, request.document, signal, HTML_OVERLAY_MAX_HTML_BYTES)
    : undefined;
  const html = loadedDocument === undefined
    ? (request.document as { readonly html: string }).html
    : new TextDecoder("utf-8", { fatal: true }).decode(loadedDocument.data);
  let totalBytes = 0;
  const resources = [];
  for (const resource of request.resources) {
    const loaded = await loadRepositoryMedia(application, { path: resource.path }, signal,
      Math.min(HTML_OVERLAY_MAX_RESOURCE_BYTES, HTML_OVERLAY_MAX_TOTAL_RESOURCE_BYTES - totalBytes));
    totalBytes += loaded.data.byteLength;
    if (totalBytes > HTML_OVERLAY_MAX_TOTAL_RESOURCE_BYTES) throw new CliError("invalid-data", "Scene resources exceed their aggregate byte bound.");
    resources.push({ declaration: resource, loaded });
  }
  const authoring = HtmlOverlayAuthoringInputSchema.parse({
    kind: "slopcamera.html-overlay", schemaVersion: 1, html,
    canvas: request.canvas, timing: request.timing, libraries: request.libraries,
    parameters: request.parameters, seed: request.seed,
    resources: resources.map(({ declaration: { path: _path, ...declaration }, loaded }) => ({
      ...declaration, bytes: loaded.artifact.bytes, sha256: loaded.artifact.sha256,
    })),
  });
  const frameCount = htmlOverlayFrameCount(request.timing);
  return { request, authoring, resources, frameCount,
    durationUs: Math.round(frameCount * 1_000_000 / request.timing.fps),
    width: request.canvas.width, height: request.canvas.height };
}

export async function planHtmlScene(application: ApplicationContext, input: unknown, signal: AbortSignal) {
  const source = await readSource(application, input, signal);
  return {
    kind: "slopcamera.html-scene-plan" as const, schemaVersion: 1 as const,
    executed: false, name: source.request.name, frameCount: source.frameCount,
    requestedDurationUs: source.request.timing.durationUs, durationUs: source.durationUs,
    width: source.width, height: source.height, fps: source.request.timing.fps,
    authoringSha256: canonicalJsonSha256(source.authoring),
    audio: source.request.audio === undefined ? "none" : "explicit-local-import",
    timingPolicy: "ceil-frames-trim-or-pad-audio-v1",
    audioValidated: false,
  };
}

const ProbeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.enum(["video", "audio"]), codec_name: z.string(),
    width: z.number().int().optional(), height: z.number().int().optional(),
    nb_read_frames: z.string().optional(), channels: z.number().int().optional(),
    sample_rate: z.string().optional(), start_time: z.string().optional(), duration: z.string().optional(),
    pix_fmt: z.string().optional(), color_range: z.string().optional(), color_space: z.string().optional(),
    color_transfer: z.string().optional(), color_primaries: z.string().optional(),
  })).min(1).max(2),
  format: z.object({ duration: z.string() }),
});

export function verifyHtmlSceneProbe(input: unknown, expected: {
  readonly width: number; readonly height: number; readonly frameCount: number;
  readonly durationUs: number; readonly audio: boolean;
}) {
  const probe = ProbeSchema.parse(input);
  const videos = probe.streams.filter(stream => stream.codec_type === "video");
  const audios = probe.streams.filter(stream => stream.codec_type === "audio");
  const video = videos[0];
  const timeUs = (text: string | undefined): number => text !== undefined && /^-?\d+(?:\.\d+)?$/u.test(text)
    ? Math.round(Number(text) * 1_000_000) : Number.NaN;
  const durationUs = timeUs(probe.format.duration);
  if (videos.length !== 1 || video?.codec_name !== "h264"
    || video.pix_fmt !== "yuv420p" || video.color_range !== "tv" || video.color_space !== "bt709"
    || video.color_transfer !== "bt709" || video.color_primaries !== "bt709"
    || video.width !== expected.width || video.height !== expected.height
    || Number(video.nb_read_frames) !== expected.frameCount
    || !Number.isSafeInteger(timeUs(video.start_time)) || Math.abs(timeUs(video.start_time)) > 1
    || !Number.isSafeInteger(timeUs(video.duration)) || Math.abs(timeUs(video.duration) - expected.durationUs) > 2
    || !Number.isSafeInteger(durationUs) || Math.abs(durationUs - expected.durationUs) > 50_000
    || audios.length !== (expected.audio ? 1 : 0)
    || audios.some(audio => audio.codec_name !== "aac" || !Number.isSafeInteger(timeUs(audio.start_time))
      || Math.abs(timeUs(audio.start_time)) > 30_000
      || !Number.isSafeInteger(timeUs(audio.duration)) || Math.abs(timeUs(audio.duration) - expected.durationUs) > 30_000
      || audio.channels !== 2 || audio.sample_rate !== "48000")) {
    throw new CliError("invalid-data", "Encoded scene failed dimensions, frame count, duration, color, or audio verification.");
  }
  return { frameCount: expected.frameCount, width: video.width, height: video.height, durationUs,
    audio: audios.length === 0 ? null : { codec: "aac", channels: 2, sampleRateHz: 48000, startTimeUs: timeUs(audios[0]!.start_time), durationUs: timeUs(audios[0]!.duration) } };
}

function placement(asset: ProjectAssetV1, durationUs: number, suffix: string) {
  const endUs = Math.min(asset.durationUs, durationUs);
  return ProjectPlacementV1Schema.parse({
    placementId: `placement_${suffix}`, assetId: asset.assetId, enabled: true,
    assetRange: { startUs: 0, endUs },
    sync: { anchors: [{ assetTimeUs: 0, projectTimeUs: 0 }, { assetTimeUs: endUs, projectTimeUs: endUs }], provenance: { kind: "identity" } },
    video: asset.streams.filter(stream => stream.kind === "video").map(stream => ({ streamId: stream.streamId,
      presentation: asset.role === "music" ? { enabled: false } : {
        enabled: true, blendMode: "normal", crop: { kind: "none" }, fit: "fill", layer: 0,
        layout: { kind: "normalized", x: 0, y: 0, width: 1, height: 1 }, opacity: 1,
      } })),
    audio: asset.streams.filter(stream => stream.kind === "audio").map(stream => ({ streamId: stream.streamId,
      presentation: { enabled: true, gainDb: 0, pan: 0 } })),
  });
}

/** Retain authoring and separate source tracks, then publish one ordinary editable video project. */
export async function renderHtmlScene(
  application: ApplicationContext, input: unknown, signal: AbortSignal, dependencies: HtmlSceneDependencies = {},
) {
  const active = async () => {
    if (signal.aborted) throw new CliError("cancelled", "HTML scene rendering was cancelled.");
    if (application.hostResourceLease === undefined) throw new CliError("unavailable", "HTML scene rendering requires an admitted host-resource lease.");
    await application.hostResourceLease.assertOwned();
  };
  await active();
  dependencies.progress?.("source");
  const source = await readSource(application, input, signal);
  if (application.htmlOverlayRenderer === undefined) throw new CliError("unavailable", "HTML scene renderer is unavailable.");
  const tools = await (dependencies.bindTools ?? bindExactCapabilities)(application, ["ffmpeg", "ffprobe", "html-browser"]);
  const tool = (name: string): ExactCapabilityBinding => {
    const found = tools.find(candidate => candidate.name === name);
    if (found === undefined) throw new CliError("unavailable", `Missing scene capability: ${name}`);
    return found;
  };
  dependencies.progress?.("browser");
  const browserRuntime = await (dependencies.bindBrowser ?? bindHtmlOverlayBrowserRuntime)(tool("html-browser"), signal);
  const suffix = `html_${randomUUID().replaceAll("-", "")}`;
  const jobDirectory = await ensurePhysicalPrivateDirectoryWithin(application.paths.repositoryRoot,
    `artifacts/slopcamera/generated/html-scenes/${suffix}`);
  const fs = createNodeBundleFileSystem(jobDirectory);
  const rootFs = createNodeBundleFileSystem(application.paths.repositoryRoot);
  const runner = new ExactCapabilityApplicationRunner(application.runner, tools, application.paths.privateRoot);
  const artifact = async (path: string, maximumBytes = MAX_MEDIA_BYTES): Promise<MediaArtifactReference> => ({
    path: relative(application.paths.repositoryRoot, join(jobDirectory, path)),
    ...await fs.inspectFile!(path, maximumBytes),
  });
  return await withMutationLock(jobDirectory, { command: "html render", label: source.request.name }, async lease => {
    const fence = async () => { await active(); await lease.assertOwned(); };
    const retainJson = async (path: string, value: unknown) => {
      await fs.writeTextNoReplace!(path, `${canonicalJson(value)}\n`, fence);
      return await artifact(path, 4 * 1024 * 1024);
    };
    const run = async (argv: readonly [string, ...string[]]) => {
      await fence();
      const result = await runner.run(argv, { abortSignal: signal, timeoutMs: PROCESS_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024, inheritedFileDescriptors: application.hostResourceLease!.inheritedFileDescriptors });
      await fence();
      if (result.exitCode !== 0) throw new CliError("subprocess", `HTML scene media step failed: ${result.stderr.trim().slice(0, 1000) || result.exitCode}`);
      return result;
    };
    await ensurePhysicalPrivateDirectoryWithin(jobDirectory, "source");
    await fs.writeTextNoReplace!("source/scene.html", source.authoring.html, fence);
    const retainedDocument = await artifact("source/scene.html", HTML_OVERLAY_MAX_HTML_BYTES);
    const retainedResources = [];
    for (const { declaration, loaded } of source.resources) {
      const destination = `source/${declaration.name}-${loaded.artifact.sha256}`;
      await rootFs.copyFileNoReplace!(loaded.artifact.path,
        relative(application.paths.repositoryRoot, join(jobDirectory, destination)), loaded.artifact, fence);
      const { path: _path, ...resource } = declaration;
      retainedResources.push({ ...resource, ...loaded.artifact, path: relative(application.paths.repositoryRoot, join(jobDirectory, destination)), absolutePath: join(jobDirectory, destination) });
    }
    let audio: Awaited<ReturnType<typeof ingestProjectMedia>> | undefined;
    if (source.request.audio !== undefined) {
      audio = await ingestProjectMedia({ ffprobe: tool("ffprobe").command, now: application.clock.now(),
        projectDirectory: jobDirectory, repositoryRoot: application.paths.repositoryRoot, role: "music",
        sourcePath: resolve(application.paths.repositoryRoot, source.request.audio.path), maximumBytes: MAX_MEDIA_BYTES,
        runner: { run: async argv => await run(argv) } });
      if (audio.asset.streams.filter(stream => stream.kind === "audio").length !== 1) throw new CliError("invalid-data", "A scene soundtrack must contain exactly one playable audio stream.");
      const soundtrack = audio.asset.streams.find(stream => stream.kind === "audio")!;
      if (soundtrack.segments.length !== 1 || soundtrack.segments[0]!.assetRange.startUs !== 0
        || soundtrack.segments[0]!.fileRange.startUs !== 0) {
        throw new CliError("invalid-data", "A scene soundtrack must begin at the imported media timeline origin. Supply an audio file without a delayed stream start.");
      }
    }
    const retainedInput = HtmlSceneInputSchema.parse({ ...source.request,
      document: { path: relative(application.paths.repositoryRoot, join(jobDirectory, "source/scene.html")) },
      resources: retainedResources.map(({ absolutePath: _absolutePath, bytes: _bytes, sha256: _sha256, ...resource }) => resource),
      ...(audio === undefined ? {} : { audio: { path: relative(application.paths.repositoryRoot, audio.absolutePath) } }),
    });
    const retainedSource = await retainJson("source.json", retainedInput);
    const authoringReceipt = await retainJson("authoring.json", source.authoring);
    const intent = await retainJson("intent.json", { kind: "slopcamera.html-scene-intent", schemaVersion: 1,
      source: retainedSource, document: retainedDocument, authoring: authoringReceipt, tools, frameCount: source.frameCount,
      durationUs: source.durationUs, requestedDurationUs: source.request.timing.durationUs,
      timingPolicy: "ceil-frames-trim-or-pad-audio-v1" });
    dependencies.progress?.("frames");
    const frameDirectory = await ensurePhysicalPrivateDirectoryWithin(jobDirectory, "render");
    const frames = await application.htmlOverlayRenderer!.renderFrames({ authoring: source.authoring,
      browserRuntime, outputDirectory: frameDirectory, resources: retainedResources,
      ...(source.request.executionProfile === undefined ? {} : { executionProfile: source.request.executionProfile }) }, signal);
    await fence();
    if (frames.frameCount !== source.frameCount || frames.framePattern !== join(frameDirectory, "frames", "frame-%08d.png")) {
      throw new CliError("invalid-data", "Scene renderer returned an unexpected frame count or output location.");
    }
    const expectedIntegrity = createHtmlOverlayExecutionBundle(source.authoring, browserRuntime, source.request.executionProfile).integrity;
    if (canonicalJsonSha256(HtmlOverlayExecutionIntegritySchema.parse(frames.executionIntegrity)) !== canonicalJsonSha256(expectedIntegrity)) {
      throw new CliError("conflict", "Scene renderer returned integrity evidence that differs from the bound browser execution.");
    }
    if (canonicalJsonSha256(HtmlOverlayActiveLibraryLocksSchema.parse(frames.libraryLocks))
      !== canonicalJsonSha256(source.authoring.libraries.map(getApprovedHtmlOverlayLibraryLock))) {
      throw new CliError("conflict", "Scene renderer returned library locks that differ from the authoring selection.");
    }
    assertHtmlOverlayGpuEvidenceProfile(source.request.executionProfile, frames.gpuEvidence);
    const frameFs = createNodeBundleFileSystem(join(frameDirectory, "frames"));
    const verifyFrames = async () => {
      const names = await readdir(join(frameDirectory, "frames"));
      if (names.length !== source.frameCount) throw new CliError("invalid-data", "Scene frame directory contains an unexpected entry.");
      const hash = createHash("sha256");
      for (let index = 0; index < source.frameCount; index++) {
        await fence();
        const name = `frame-${String(index).padStart(8, "0")}.png`;
        const found = await frameFs.inspectFile!(name, source.width * source.height * 5 + 1024 * 1024);
        const first = await readPngHeader(join(frameDirectory, "frames", name), found.bytes);
        if (first.length < 33 || first.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
          || first.toString("ascii", 12, 16) !== "IHDR" || first.readUInt32BE(16) !== source.width || first.readUInt32BE(20) !== source.height) {
          throw new CliError("invalid-data", "Rendered scene frame differs from the declared PNG dimensions.");
        }
        hash.update(`${index}:${found.bytes}:${found.sha256}\n`);
      }
      return hash.digest("hex");
    };
    const frameSha256 = await verifyFrames();
    const frameReceipt = await retainJson("frames.json", { ...frames, frameSha256 });
    const videoPath = join(jobDirectory, "scene.mp4"), outputPath = join(jobDirectory, "video.mp4");
    const frameRate = String(source.request.timing.fps), duration = (source.durationUs / 1_000_000).toFixed(6);
    const background = source.request.background.replace("#", "0x");
    dependencies.progress?.("encode");
    await run([tool("ffmpeg").command, "-nostdin", "-v", "error", "-n", "-threads", "2",
      "-protocol_whitelist", "file", "-f", "image2", "-framerate", frameRate, "-start_number", "0", "-i", frames.framePattern,
      "-filter_complex_threads", "1", "-filter_complex",
      `color=c=${background}:s=${source.width}x${source.height}:r=${frameRate},format=rgba[bg];[bg][0:v]overlay=shortest=1:format=auto,format=rgb24[v]`,
      "-map", "[v]", "-an", "-frames:v", String(source.frameCount), "-c:v", "libx264rgb", "-crf", "0", "-preset", "fast",
      "-threads", "2", "-color_trc", "iec61966-2-1", "-color_primaries", "bt709", "-colorspace", "rgb", "-color_range", "pc",
      "-fs", String(MAX_MEDIA_BYTES), videoPath]);
    const videoArtifact = await artifact("scene.mp4");
    if (await verifyFrames() !== frameSha256) throw new CliError("conflict", "Scene frame bytes changed during encoding.");
    const audioStream = audio?.asset.streams.find(stream => stream.kind === "audio");
    if (audio !== undefined) for (const stream of audio.asset.streams) for (const segment of stream.segments) {
      await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: segment.path, expected: segment, label: "Scene soundtrack" });
    }
    await run([tool("ffmpeg").command, "-nostdin", "-v", "error", "-n", "-threads", "2",
      ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS, "-i", videoPath,
      ...(audio === undefined ? [] : [...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS, "-i", audio.absolutePath]),
      "-map", "0:v:0", ...(audioStream === undefined ? ["-an"] : ["-map", `1:${audioStream.segments[0]!.streamIndex}`, "-af", "asetpts=PTS-STARTPTS,apad", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2"]),
      "-vf", "scale=in_range=pc:out_range=pc:out_color_matrix=bt709,format=yuv444p,colorspace=ispace=bt709:itrc=iec61966-2-1:iprimaries=bt709:irange=pc:space=bt709:trc=bt709:primaries=bt709:range=tv:format=yuv420p:fast=0",
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-threads", "2", "-filter_threads", "1", "-t", duration, "-r", frameRate,
      "-color_trc", "bt709", "-color_primaries", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-movflags", "+faststart",
      "-fs", String(MAX_MEDIA_BYTES), outputPath]);
    dependencies.progress?.("verify");
    const inspected = await run([tool("ffprobe").command, "-v", "error", ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
      "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames,channels,sample_rate,start_time,duration,pix_fmt,color_range,color_space,color_transfer,color_primaries:format=duration", "-of", "json", outputPath]);
    const verification = verifyHtmlSceneProbe(JSON.parse(inspected.stdout) as unknown, { ...source, audio: audio !== undefined });
    const output = await artifact("video.mp4");
    const importedVideo = await ingestProjectMedia({ ffprobe: tool("ffprobe").command, now: application.clock.now(),
      projectDirectory: jobDirectory, repositoryRoot: application.paths.repositoryRoot, role: "screen", sourcePath: videoPath,
      maximumBytes: MAX_MEDIA_BYTES, runner: { run: async argv => await run(argv) } });
    if (importedVideo.asset.source.kind !== "imported" || importedVideo.asset.source.sourceSha256 !== videoArtifact.sha256) {
      throw new CliError("conflict", "Scene video changed before its editable project import.");
    }
    const videoAsset = ProjectAssetV1Schema.parse({ ...importedVideo.asset,
      source: { kind: "generated", generator: "slopcamera.html-scene", generatorVersion: "1", sourceSha256: intent.sha256 } });
    dependencies.progress?.("project");
    const projectId = `project_${suffix}`, timestamp = application.clock.now().toISOString();
    const videoPlacement = placement(videoAsset, source.durationUs, `${suffix}_video`);
    const project = VideoProjectV1Schema.parse({
      kind: "slopcamera.video-project", schemaVersion: 1, projectId, name: source.request.name,
      createdAt: timestamp, updatedAt: timestamp, currentEditPlanPath: "edits/current.json", analyses: [],
      assets: [videoAsset, ...(audio === undefined ? [] : [audio.asset])],
      placements: [videoPlacement, ...(audio === undefined ? [] : [placement(audio.asset, source.durationUs, `${suffix}_audio`)])],
      referencePlacementId: videoPlacement.placementId, timeline: { timebase: "microseconds", durationUs: source.durationUs },
    });
    const plan = createDefaultProjectEditPlan(project, ProjectEditPlanV1Schema.shape.planId.parse(`plan_${suffix}`), timestamp);
    for (const retained of [retainedSource, retainedDocument, authoringReceipt, intent, frameReceipt, videoArtifact, output, ...retainedResources]) {
      await fence();
      await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: retained.path, expected: retained, label: "Retained scene source" });
    }
    if (audio !== undefined) for (const stream of audio.asset.streams) for (const segment of stream.segments) {
      await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: segment.path, expected: segment, label: "Scene soundtrack after encoding" });
    }
    const projectDirectory = await ensurePhysicalPrivateDirectoryWithin(application.paths.projectRoot, projectId);
    const projectFs = createNodeBundleFileSystem(projectDirectory);
    await ensurePhysicalPrivateDirectoryWithin(projectDirectory, "edits");
    const receipt = await retainJson("receipt.json", { kind: "slopcamera.html-scene-receipt", schemaVersion: 1,
      intent, source: retainedSource, document: retainedDocument, authoring: authoringReceipt, frameReceipt, video: videoArtifact, output,
      projectId, projectSha256: canonicalJsonSha256(project), planSha256: canonicalJsonSha256(plan), verification,
      audio: audio?.asset ?? null, timingPolicy: "ceil-frames-trim-or-pad-audio-v1" });
    await projectFs.writeTextNoReplace!("html-scene.json", canonicalJson({ source: retainedSource, receipt }), fence);
    await projectFs.writeTextNoReplace!("edits/current.json", canonicalJson(plan), fence);
    await projectFs.writeTextNoReplace!("project.json", canonicalJson(project), fence);
    await fence();
    dependencies.progress?.("complete");
    return { kind: "slopcamera.html-scene-export" as const, schemaVersion: 1 as const, output, receipt,
      source: retainedSource, projectId, projectPath: relative(application.paths.repositoryRoot, join(projectDirectory, "project.json")), verification };
  });
}

export async function executeHtmlSceneCommand(application: ApplicationContext, command: {
  readonly input: string; readonly dryRun: boolean;
}, signal: AbortSignal, dependencies: HtmlSceneDependencies = {}) {
  const input = await readSpatialJson(resolve(application.paths.repositoryRoot, command.input), MAX_REQUEST_BYTES);
  return command.dryRun ? await planHtmlScene(application, input, signal)
    : await renderHtmlScene(application, input, signal, dependencies);
}
