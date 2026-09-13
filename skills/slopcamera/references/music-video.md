# Render a music video from an authored scene

Use this workflow for a complete HTML or Three.js music video with a local track,
including dancing characters, changing landscapes, and musical light accents.
The export retains the source and creates an ordinary editable project with
separate scene video and original music.

## Confirm the input and local capability

Use the user's selected track and supplied tempo. Establish an explicit duration,
beat-zero offset, and beats per bar from the task or relevant audio inspection.
The first version does not detect tempo, downbeats, or track duration. Do not
replace explicit musical timing with an unsupported automatic-analysis claim.

Check the installed command and host before preparing exact source:

```sh
slopcamera help html
slopcamera doctor --json
```

The current-source CLI must list `html render`. Rendering needs the admitted local
Chrome runtime and FFmpeg/FFprobe. Follow [installation and readiness](install.md)
if the installed version lacks the command. The HTML render stays local; it does
not require uploading the user's music to a generation service.

## Keep the source reproducible

Create an HTML document in the task workspace. For core Three.js, start with
`slopcamera html scaffold three --output scenes/music-video.html`. The source
repository also includes an original articulated robot and island scene at
[`examples/html/music-video.html`](https://github.com/hraness/slopcamera/blob/main/examples/html/music-video.html)
with a matching scene request. The example uses core Three.js and no external
assets. Its supplied request selects a qualified macOS hardware profile; a
request without `executionProfile` uses the default browser profile.

Save a scene request such as this at the workspace root, replacing the duration,
timing, and track path with the selected values:

```json
{
  "kind": "slopcamera.html-scene",
  "schemaVersion": 1,
  "name": "Island music video",
  "document": { "path": "scenes/music-video.html" },
  "canvas": { "width": 1280, "height": 720, "deviceScaleFactor": 1 },
  "timing": { "durationUs": 43204320, "fps": 30 },
  "libraries": ["three"],
  "seed": 8888,
  "parameters": {
    "music": { "bpm": 88.88, "beatOffsetUs": 0, "beatsPerBar": 4 }
  },
  "resources": [],
  "audio": { "path": "/absolute/path/to/track.mp3" }
}
```

The movie uses the specified `canvas.width` and `canvas.height`, which must be
even integers. `deviceScaleFactor` changes internal rendering density without
changing those output dimensions. Keep it at `1` while iterating.

Document and resource paths are relative to the workspace root, including when
the JSON is in a subdirectory. Declare external textures and model data in
`resources`, and load only their declared names through `SlopcameraOverlay.asset`.
The audio path can be absolute. Keep original media and attribution beside the
source; omit `audio` for a silent scene. Do not invent asset licenses.

The soundtrack must contain exactly one playable audio stream beginning at the
imported media timeline origin. A delayed stream start is rejected before frames
render.

[Imported character preparation](https://github.com/hraness/slopcamera/blob/main/docs/reference/sdk.md#prepare-rigged-glb-assets)
supports uncompressed skinned GLB. Draco
compression, morph targets, and embedded animation clips are unsupported. The
included mascot uses named articulated joints and does not require an imported
character. Describe the actual articulation accurately.

## Animate from absolute musical time

Inside `SlopcameraOverlay.onFrame`, convert the supplied `timeMs` to integer
microseconds with `Math.round(timeMs * 1000)`, then call
`SlopcameraOverlay.musicClock(timeUs, SlopcameraOverlay.parameters.music)`.

- Use `beatPosition` for continuous motion and phrase transitions.
- Use `beatIndex` and `barIndex` for signed musical indices, and `beatPhase` and
  `barPhase` for normalized phases in `[0, 1)`.
- Use `SlopcameraOverlay.musicPulse(beatPhase, widthBeats)` for a smooth periodic
  accent centered on the beat. Width is in `(0, 1]` and defaults to `0.5`.
- Restore a saved pose or compute each joint transform directly from absolute
  time. Never accumulate rotations, use wall-clock time, or add a second frame
  loop.

Use smooth phrase transitions, restrained camera motion, and local light accents.
Maintain multisample antialiasing on the scene render target if adding
post-processing. Bound draw calls, geometry, and shader work, and validate frame
zero before a full render.

Smooth effects are not a seizure-safety certificate. The timing and pulse helpers
do not analyze rendered flashes or certify safety. Review the actual result and
avoid claiming a safety guarantee.

## Validate, render, and review

```sh
slopcamera html render --input music-video.json --dry-run --json
slopcamera html render --input music-video.json --json
```

Dry run checks the schema, local HTML and resources, workload bounds, planned
dimensions, and frame count. It does not launch Chrome, validate or import audio,
or create a project. Keep `timing.durationUs` explicit even with audio. The output
rounds up to whole frames; audio starts at zero and is trimmed or padded with
silence. `beatOffsetUs` changes the visual clock, not the audio placement.

Use returned `output.path`, `receipt.path`, `source.path`, `projectId`, and
`projectPath`. Artifact paths are relative to the workspace root. The retained
job includes original HTML, declared resources, original music when supplied,
source and render receipts, lossless RGB `scene.mp4`, and delivery `video.mp4`.
The delivery is H.264 with optional 48 kHz stereo AAC at 320 kb/s. Its ordinary
project keeps the scene video and original music separate. Input files remain
unchanged.

The returned `source.path` identifies a reusable `source.json` request with the
original canvas, frame rate, timing, seed, parameters, and other render settings.
Its paths point to retained inputs. Rerun those scene settings with the returned
path in place of `<source.path>`:

```sh
slopcamera html render --input <source.path> --json
```

Inspect the returned duration, frame count, dimensions, and audio stream. Watch
the first and last frames, choreography, framing, phrase changes, and accents;
listen for beat alignment and the ending. State any missing visual or listening
verification.

Use [video projects](video-projects.md) to continue editing the returned project.
Ordinary project rendering defaults to 1920×1080 at 60 fps and uses the editor's
normal color and audio processing. Set dimensions and frame rate explicitly:

```sh
slopcamera project render plan <project-id> --width 1280 --height 720 --fps 30 --output renders/edited.mp4 --json
```

Matching those settings does not guarantee identical picture or sound to the
scene export. Review the edited delivery separately, and rerun `source.json`
through `html render` when the original scene settings are required. Revise the
working HTML and render a new request for choreography or scenery changes,
preserving each retained source and receipt with its movie.
