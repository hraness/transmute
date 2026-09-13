# SDK and workflow surfaces

Slopcamera exposes a portable Bun SDK and a complete local media host. Imports select their capability boundary; installing a package does not enable every operation in every host. See [version and capability support](capabilities.md) before using current-source additions.

## Public entrypoints

| Import | Contract |
| --- | --- |
| `@hraness/slopcamera` | Diagram schemas/rendering, vectorization and portable scene/studio contracts and pure planning helpers. |
| `@hraness/slopcamera/code` | Declarative authoring and compilation against the portable, fixed four-operation projection. |
| `@hraness/slopcamera/code/advanced` | Lower-level portable graph, compiler and planning contracts. |
| `@hraness/slopcamera/operations` | The fixed portable semantic operation registry. |
| `@hraness/slopcamera/workflow` | Preserved imperative v0.8 API for explicitly imported trusted Bun workflows. |
| `@hraness/slopcamera/host-resources` | Host resource admission contracts. |
| `@hraness/slopcamera/local/code` | Local declarative authoring, schemas and complete media capability projection. |
| `@hraness/slopcamera/local/code/advanced` | Local graph planning, execution and host integration. |
| `@hraness/slopcamera/local/code/workflows` | Checked built-in local workflow definitions. |
| `@hraness/slopcamera/local/html-overlay` | Local HTML authoring, scene-input schemas, music-clock helpers, rigged GLB preparation, profiles and contracts. |

There is no public `@hraness/slopcamera/code/testing` or portable `@hraness/slopcamera/code/workflows` entrypoint. The local subpaths need the source-backed Bun distribution; they are not browser SDKs.

## Portable and local operations

The portable projection contains diagram check/render and image generate/vectorize. Portable spatial and studio schemas can parse, hash and plan values without making their local executors available. A graph containing an unsupported operation fails before executor or resource admission.

The local builder adds `analysis`, `edits`, `gateway`, `iteration`, `studio`, `scene`, `spatialProject`, `media`, `project`, `render` and `recording` operations. Inspect the current registry and built-in schemas through the host:

```sh
slopcamera operations list --json
slopcamera operations show slopcamera.studio.run --json
slopcamera workflows list --json
slopcamera workflows show directed-scene --json
```

The registries are closed. An operation input is typed data, not a caller-selected executable, shell command, dynamic loader or registration hook.

Local `media.ingest` imports into an existing project. The public CLI creates ordinary projects from a stopped recording, a successful studio/directing assembly, or, in current source, `html render` with an authored scene and optional local soundtrack. There is no public SDK project-create operation for arbitrary independent files. Access to TypeScript types does not authorize calling private storage constructors.

## Music timing for HTML scenes

`HtmlSceneInputSchema` parses the `slopcamera.html-scene` version-one request used by `slopcamera html render`. It accepts a document, canvas, explicit timing, seed, library selection, parameters, declared resources, and optional local audio. The command performs the render and ordinary-project creation. See [the music-video guide](../how-to/music-video.md) for a complete request.

The local HTML entrypoint exports `HtmlOverlayMusicTimingSchema`, `sampleHtmlOverlayMusicClock(timeUs, timing)`, and `htmlOverlayMusicPulse(beatPhase, widthBeats)`. Authored browser documents use the equivalent `SlopcameraOverlay.musicClock(...)` and `SlopcameraOverlay.musicPulse(...)` methods.

| Value | Contract |
| --- | --- |
| `timeUs` | Absolute integer microseconds within ±3,600,000,000. Convert an `onFrame` callback's `timeMs` with `Math.round(timeMs * 1000)`. |
| `timing` | `{ bpm, beatOffsetUs, beatsPerBar }`: constant tempo from 20 to 400 BPM, the absolute integer-microsecond time of beat zero within ±3,600,000,000, and one to 32 beats per bar. |
| Clock result | `{ beatPosition, beatIndex, beatPhase, barIndex, barPhase }`. Positions and indices can be negative before beat zero; indices round down and phases lie in `[0, 1)`. |
| `widthBeats` | Full nonzero pulse width in `(0, 1]`, default `0.5`, with equal anticipation and decay around the beat. |
| Pulse result | A value in `[0, 1]` with zero slope at the beat seam and support edges. |

These helpers sample declared musical timing. They do not detect tempo, inspect the soundtrack, or analyze rendered flashes. Scene authors still own the amplitude, area, color, and timing of visible effects.

## Prepare rigged GLB assets

`prepareThreeRiggedGlb(bytes, options)` prepares a self-contained, uncompressed skinned GLB for an authored HTML Three scene. It returns source identity and bone inspection, a local JavaScript module, and extracted texture resources. Preparation is pure: it reads no files, starts no browser, and fetches no decoders. The generated module uses the scene's approved core `three` library.

| Value | Contract |
| --- | --- |
| `options` | `{ name, provenance }`. Use a unique lowercase hyphenated resource name, up to 32 characters. Provenance requires `source: "authored" \| "imported"` and `description`; `sourceUrl`, `license`, and `attribution` are optional recorded facts. |
| `prepared.inspection` | Original GLB byte length and SHA-256, provenance, evaluated rest bounds, geometry counts, bones with source node indices and names, and extracted image declarations. Bounds use glTF's Y-up coordinates and source transforms. |
| `prepared.resources` | Detached `{ declaration, bytes }` entries for the module and textures. Write the bytes and preserve each declaration's name, URL path, and media type. |
| `prepared.moduleResource` | The declaration whose name identifies the module. `createThreeRiggedGlbModule(prepared)` returns that same module's source text. |

Run preparation in a trusted Bun script from the workspace root. Use a fresh output directory, retain the original GLB and inspection beside the generated resources, and copy the resulting `resources` array into the scene request:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prepareThreeRiggedGlb } from "@hraness/slopcamera/local/html-overlay";

const original = await readFile("assets/mascot.glb");
const prepared = prepareThreeRiggedGlb(original, {
  name: "mascot",
  provenance: { source: "imported", description: "Selected character for this scene" },
});
const directory = "artifacts/slopcamera/generated/mascot-rig";
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/source.glb`, original, { flag: "wx" });
await writeFile(`${directory}/inspection.json`, JSON.stringify(prepared.inspection), { flag: "wx" });
const resources = [];
for (const { declaration, bytes } of prepared.resources) {
  const path = `${directory}/${declaration.name}`;
  await writeFile(path, bytes, { flag: "wx" });
  const { bytes: _bytes, sha256: _sha256, ...resource } = declaration;
  resources.push({ ...resource, path });
}
await writeFile(`${directory}/resources.json`, JSON.stringify(resources), { flag: "wx" });
```

The scene command binds the exact resource bytes when it loads these paths. No GLTFLoader addon or additional library selection is needed. Inside your existing Three scene module, call `ready` and `onFrame` synchronously when the module starts. Put asynchronous module and texture loading inside the promise passed to `ready`, then restore the rest pose before each absolute-time pose:

```js
let rig;
SlopcameraOverlay.ready((async () => {
  const { createRig } = await import(SlopcameraOverlay.asset("mascot-module"));
  rig = await createRig(THREE);
  scene.add(rig.root);
  renderer.compile(scene, camera);
})());
SlopcameraOverlay.onFrame(({ timeMs }) => {
  rig.resetPose();
  const beat = SlopcameraOverlay.musicClock(Math.round(timeMs * 1000), {
    bpm: 88.88, beatOffsetUs: 0, beatsPerBar: 4,
  });
  rig.bones[0].rotateZ(0.15 * Math.sin(2 * Math.PI * beat.beatPosition));
  renderer.render(scene, camera);
});
```

Here `THREE`, `scene`, `renderer`, and `camera` come from your authored scene. Select specific joints with `rig.boneByName(name)` using the inspection; duplicate names require `rig.nodes[sourceNodeIndex]`. Stage the character through `rig.root`; `resetPose()` preserves that outer position, rotation, and scale. Call `rig.dispose()` when removing the rig. The module awaits declared textures and never uses network model loading or blob URLs.

The profile supports triangle geometry, four skin influences per vertex, TRS or TRS-decomposable node matrices, and bounded base-color PBR materials with embedded PNG/JPEG textures. It admits at most 1,024 nodes, 64 skins, 256 joints per skin, 32 extracted images, and a 32 MiB generated module, within the existing GLB geometry and byte budgets. Draco and other extensions, morph targets, sparse accessors, external dependencies, and embedded animation clips reject. Preserve a decoded derivative's original source and attribution. This helper does not change the portable spatial-scene GLB profile, which continues to reject skins.

## Checked examples

| Example | Host and purpose |
| --- | --- |
| [declarative-workflow.ts](../../examples/declarative-workflow.ts) | Portable diagram workflow and graph authoring. |
| [render-workflow.ts](../../examples/render-workflow.ts) | Preserved imperative Bun workflow. |
| [native-workflow.ts](../../examples/studio/native-workflow.ts) | Local native job through the durable scheduler. |
| [hybrid-scene.ts](../../examples/studio/hybrid-scene.ts) | Pure shared-city and world-media scene construction from admitted assets. |
| [music-video.html](../../examples/html/music-video.html) and [music-video.json](../../examples/html/music-video.json) | Original articulated Three.js mascot, procedural island scenery, and a scene-export request with explicit music timing. |

The native example exports this workflow definition:

```ts
import { defineWorkflow, StudioRunInputSchema } from "@hraness/slopcamera/local/code";

export default defineWorkflow({
  id: "native-studio-shot",
  version: 1,
  inputSchemaId: "native-studio-shot-input-v1",
  inputSchema: StudioRunInputSchema,
  build(workflow, input) {
    return { shot: workflow.studio.run("produce-shot", input) };
  },
});
```

Its input binds the retained bundle manifest and exact job. The host invocation supplies runtime paths and the separate `--allow-trusted-code` authorization; those permissions are not stored in the graph. The result contains generic output file references and a native receipt, not a new project type. Follow [running workflows](../how-to/run-workflows.md) for plan, approval and resume commands.

## Execution and trust

Pure schema parsing and portable planning do not execute authored native source. Loading a custom TypeScript workflow for `code check` or `code plan` does execute the trusted Bun module's top-level code; withholding registered effects is not an OS sandbox.

The local scheduler binds exact artifacts, operation plans and observed runtime identities. It admits physical work under resource claims, retains progress and receipts, and rejects incompatible inputs on resume. Runtime identity is evidence about the selected tools and observed environment, not proof of a hermetic operating system.

Effect approval and native source authorization have different scopes. `runs approve` records an exact preparation or node plan. Native execution also needs an invocation-scoped trusted-current-user envelope. An ambiguous external or native attempt must be reconciled; a missing journal is not proof that nothing ran. Cancellation cannot roll back a completed provider request or published artifact.

## MCP and canvas interchange

`slopcamera mcp` offers compatibility diagram tools and the bounded portable semantic registry. Paths are root-relative, configuration is inert, and diagram tools admit at most 64 shapes and 128 edges with at most 40 reported findings. The CLI supports larger checked diagrams and trusted workspace configuration.

Generated `.tldr` is editable interchange. `slopcamera canvas open <file.tldr>` passes it to tldraw Offline; saving there creates the app's native `.tldraw` bundle. The diagram JSON remains Slopcamera's authored source. See the [diagram tutorial](../tutorials/first-diagram.md) for source and export behavior.
