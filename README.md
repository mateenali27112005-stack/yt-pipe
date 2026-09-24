# Episode Production Agent

The V0.1 brain skeleton compiles strict structured Markdown into an immutable EpisodeSpec snapshot and a separate validation report. It contains no provider integrations, and keeps story intent separate from runtime state and generated files.

## Run

```bash
npm run parse -- examples/episode_001.md output/EP_001/v1 --episode-id EP_001
```

Optional registry validation:

```bash
npm run parse -- examples/episode_001.md output/EP_001/v1 --series-registry examples/series_registry.json --series-id SERIES_AWAKENING --episode-id EP_001
```

The command writes `episode.json` and `validation.json`. It exits with code `1` when blocking validation errors are present and `2` for CLI or file errors. Existing artifacts are protected from accidental overwrite; create a new versioned output directory for a revised specification or explicitly pass `--overwrite`.

`specVersion` starts at `1`; use `--spec-version 2 --parent-spec-version 1` for a revised immutable snapshot. V0.1 scene and shot IDs are structural (`SC_001`, `SH_001_001`), so prose changes do not change them. Reordering source sections is a separate future identity-resolution concern.

## Supported Markdown

```md
# Episode: The Awakening

## Scene: The Ruined Temple
Location: ruined_temple
Time: night
Purpose: Kael discovers the forbidden symbol.

### Shot
Purpose: Reveal the forbidden symbol.
Characters:
- Kael
Narration: The symbol had been buried for centuries.
Dialogue: Kael: What is this?
Visual: Extreme close-up of an ancient glowing symbol carved into stone.
Timing: min: 3.5 target: 4.2 max: 5.0
```

V0.1 deliberately rejects free-form prose and does not call media, AI, or publishing services.

## V0.2 Audio

V0.2 consumes a validated `episode.json` without mutating it. It writes audio assets, an `audio_manifest.json`, and a `realized_timeline.json` whose durations are measured from the generated files.

```bash
npm run audio -- output/episode.json output/EP_001/audio/v1 --voice-registry examples/voice_registry.json
```

The initial local provider uses macOS `say` and `afinfo`, producing AIFF files. The voice registry assigns the narrator and optional character voices. A dialogue speaker must be present in the shot's declared character list. Audio artifacts are protected from overwrite unless `--overwrite` is explicitly passed.

## V0.3 Visual Contracts

V0.3 does not generate images. It deterministically derives a `shot_visual_spec.json` for each shot from a validated EpisodeSpec and matching realized timeline, then creates an `asset_manifest.json` with one planned visual asset version per shot.

```bash
npm run visual-plan -- output/episode.json path/to/realized_timeline.json output/EP_001/visual/v1 --visual-profile examples/visual_profile.json
```

Each visual spec records character and location IDs, visual intent, framing, action, expression, lighting, mood, camera intent, style reference, realized timing, and a source hash. The asset manifest records a stable asset identity (`VAS_<shotId>`), a single active planned version, and all prior versions. Plan a regeneration without generating an image:

```bash
npm run visual-regenerate -- output/EP_001/visual/v1/asset_manifest.json VAS_SH_001_001 --overwrite
```

Regeneration appends the next immutable asset version and moves the active pointer while retaining the prior version. V0.3 has no image provider, cloud API, GPU inference, image-to-video, or rendering.
