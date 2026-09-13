# Make a music video from an HTML scene

Render an authored HTML or Three.js scene with a local soundtrack into an MP4 and an ordinary editable Slopcamera project. The project keeps the rendered scene and original music as separate sources, so you can continue editing without extracting audio from the finished movie.

Use a [current-source build](use-current-source.md) whose `slopcamera help html` lists `html render`. Rendering requires the admitted local Chrome runtime and FFmpeg/FFprobe. Check the host before preparing a full render:

```sh
slopcamera help html
slopcamera doctor --json
```

## Prepare the scene request

Start with the original [articulated robot and island scene](../../examples/html/music-video.html) and its [scene request](../../examples/html/music-video.json). The visuals use core Three.js and no external assets. The supplied request selects `three-webgl2-hardware-v1`, which requires the [qualified macOS hardware profile](../reference/capabilities.md#local-execution-profiles).

For your own request, save the following as `music-video.json` at the workspace root. Replace the audio path with your selected local track. This request uses the default browser profile; add `executionProfile` when you require a specific supported profile.

```json
{
  "kind": "slopcamera.html-scene",
  "schemaVersion": 1,
  "name": "Island music video",
  "document": { "path": "examples/html/music-video.html" },
  "canvas": { "width": 1280, "height": 720, "deviceScaleFactor": 1 },
  "timing": { "durationUs": 43204320, "fps": 30 },
  "libraries": ["three"],
  "seed": 8888,
  "parameters": {
    "music": { "bpm": 88.88, "beatOffsetUs": 0, "beatsPerBar": 4 }
  },
  "audio": { "path": "/absolute/path/to/track.mp3" }
}
```

Run the commands from the workspace root. `document.path` and each declared resource's `path` are relative to that root, including when the JSON lives in a subdirectory. Keep the HTML and its resources inside the workspace. `audio.path` can be an explicit absolute local path. Omit the `audio` object for a silent video.

The soundtrack must contain exactly one playable audio stream beginning at the imported media timeline origin. A delayed audio stream start is rejected before rendering frames.

Set `timing.durationUs` explicitly, even when supplying audio. Version one does not infer duration, tempo, or downbeats from the track. The final duration rounds up to a whole number of frames. Audio begins at time zero and is trimmed or padded with silence to that duration. `beatOffsetUs` controls the visual beat clock; it does not move or trim the audio.

The movie dimensions are the specified `canvas.width` and `canvas.height`, which must be even integers. `deviceScaleFactor` changes internal rendering density without changing the output dimensions; keep it at `1` while iterating. The usual HTML workload bounds apply. If you add images or model data, declare them in `resources` and resolve their names with `SlopcameraOverlay.asset(...)`; ambient network asset loading is unavailable.

## Align motion to the music

Set `parameters.music` to the track's known constant tempo, beat-zero offset in integer microseconds, and beats per bar. The example falls back to `88.88`, `0`, and `4` when these values are omitted. Listen to the track with the render to check that the chosen offset matches the intended beat.

Inside an authored scene, sample the clock from the absolute frame time:

```js
SlopcameraOverlay.onFrame(({ timeMs }) => {
  const beat = SlopcameraOverlay.musicClock(
    Math.round(timeMs * 1000),
    SlopcameraOverlay.parameters.music,
  );
  const accent = SlopcameraOverlay.musicPulse(beat.beatPhase, 0.7);
  dancer.rotation.z = 0.08 * Math.sin(Math.PI * beat.beatPosition);
  ring.material.emissiveIntensity = 0.7 + 0.5 * accent;
  renderer.render(scene, camera);
});
```

Here `dancer`, `ring`, `scene`, `camera`, and `renderer` are objects created by your document. Derive every pose from the sampled time or a saved rest pose. Avoid accumulated rotations, wall-clock time, and a second animation loop. Use beat and bar positions for larger changes in choreography, landscapes, and camera movement. The [SDK reference](../reference/sdk.md#music-timing-for-html-scenes) describes the clock fields and pulse width.

The example uses smooth local light accents and gradual scenery changes. Smooth musical effects are not a seizure-safety certificate: these helpers do not analyze the rendered frames for flashes or certify viewer safety. Review the actual movie before delivery.

The included mascot uses named articulated joints. [Imported character preparation](../reference/sdk.md#prepare-rigged-glb-assets) currently supports uncompressed skinned GLB; Draco compression, morph targets, and embedded animation clips are unsupported. Preserve the asset's source and required attribution when replacing the example character.

## Check the plan and render

Validate the source and inspect the planned dimensions, frame count, and rounded duration:

```sh
slopcamera html render --input music-video.json --dry-run --json
```

Dry run checks the request, local document and declared resources, and workload bounds. It does not launch Chrome, validate or import the audio, or create project state. A successful plan does not prove that the scene's shaders or soundtrack will render.

Render the checked request:

```sh
slopcamera html render --input music-video.json --json
```

Progress goes to stderr; `--json` keeps stdout machine-readable. Use the returned `output.path`, `receipt.path`, `source.path`, `projectId`, and `projectPath`. Artifact paths are relative to the workspace root.

The retained job under `artifacts/slopcamera/generated/html-scenes/` includes the HTML, declared resources, original soundtrack when supplied, source and render receipts, a lossless RGB `scene.mp4`, and the delivery `video.mp4`. The delivery uses H.264 video and, when audio is present, 48 kHz stereo AAC at 320 kb/s. The ordinary project references the scene video and original music separately. The input files remain unchanged.

The returned `source.path` identifies `source.json`, a reusable scene request. It preserves the original canvas, frame rate, timing, seed, parameters, and other render settings, with source paths pointing to retained inputs. To rerun those scene settings, replace `<source.path>` with that returned path:

```sh
slopcamera html render --input <source.path> --json
```

## Review and continue editing

Watch the full delivery with sound. Check the intended beat alignment, character framing, phrase transitions, bright accents, and first and last frames. Confirm the returned duration, dimensions, frame count, and audio stream. Distinguish those technical checks from a visual or listening review you could not perform.

Inspect the returned project before adding footage or changing its edit:

```sh
slopcamera project inspect <project-id> --json
```

Ordinary project rendering has its own defaults: 1920×1080 at 60 fps. Set the size and frame rate explicitly when planning an edited delivery:

```sh
slopcamera project render plan <project-id> --width 1280 --height 720 --fps 30 --output renders/edited.mp4 --json
```

This uses the ordinary editor's color and audio processing. Matching the dimensions and frame rate does not guarantee the same picture or sound as the scene export. Review the edited delivery separately; rerun `source.json` through `html render` when you want the original scene settings.

Use [ordinary project editing](edit-video.md) for cuts, additional media, captions, and delivery variants. To change the choreography or scenery, revise your working HTML and render a new scene request. Preserve each retained source and receipt with its movie.
