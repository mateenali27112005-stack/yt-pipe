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

V0.2 consumes a validated `episode.json` without mutating it. It writes audio assets, an `audio_manifest.json`, and a versioned `realized_timeline.json` whose durations are measured from the generated files.

```bash
npm run audio -- output/episode.json output/EP_001/audio/v1 --voice-registry examples/voice_registry.json --timeline-version 1
```

The initial local provider uses macOS `say` and `afinfo`, producing AIFF files. The voice registry assigns the narrator and optional character voices. A dialogue speaker must be present in the shot's declared character list. Audio artifacts are protected from overwrite unless `--overwrite` is explicitly passed.

## V0.3 Visual Contracts

V0.3 does not generate images. It derives deterministic planning content for each shot from a validated EpisodeSpec and matching realized timeline, with runtime provenance metadata, then creates an `asset_manifest.json` with one planned visual asset version per shot.

```bash
npm run visual-plan -- output/episode.json path/to/realized_timeline.json output/EP_001/visual/v1 --visual-profile examples/visual_profile.json --visual-spec-version 1
```

Each visual spec records the source EpisodeSpec version, source timeline version, its own visual-spec version, character and location IDs, visual intent, framing, action, expression, lighting, mood, camera intent, style reference, realized timing, and a source hash. The asset manifest records the source visual-spec version, a stable asset identity (`VAS_<shotId>`), a single active planned version, and all prior versions. Plan a regeneration without generating an image:

```bash
npm run visual-regenerate -- output/EP_001/visual/v1/asset_manifest.json VAS_SH_001_001 --overwrite
```

Regeneration appends the next immutable asset version and moves the active pointer while retaining the prior version. V0.3 has no image provider, cloud API, GPU inference, image-to-video, or rendering.

## V0.4 Image Generation

V0.4 consumes the exact V0.3 `ShotVisualSpec` and `AssetManifest` contracts. Each provider creates a new immutable `GENERATED` asset version with its PNG path, byte length, model, prompt hash, and optional revised prompt. It never alters a previous planned or generated version.

Use the deterministic local provider to exercise the full lifecycle without a network call or API key:

```bash
npm run visual-generate -- output/EP_001/visual/v1/shot_visual_spec.json output/EP_001/visual/v1/asset_manifest.json VAS_SH_001_001 --provider fake --overwrite-manifest
```

Use OpenAI explicitly when an API key is available:

```bash
OPENAI_API_KEY=... npm run visual-generate -- output/EP_001/visual/v1/shot_visual_spec.json output/EP_001/visual/v1/asset_manifest.json VAS_SH_001_001 --provider openai --overwrite-manifest
```

The CLI requires explicit provider selection (`fake` or `openai`). The adapter uses the OpenAI Images API with `gpt-image-2.5-flare`; the provider is replaceable behind `ImageProvider`. It fails before making a request when `OPENAI_API_KEY` is unavailable, refuses visual-spec and manifest provenance mismatches, and removes a newly generated PNG if manifest publication fails.

## V0.5 Series Bible and Visual Continuity

V0.5 adds a versioned `SeriesBible` with canonical characters, locations, visual styles, and optional reference assets. A V0.5 visual plan records a deterministic continuity snapshot for every shot and the source Bible version. The manifest preserves that provenance transitively through its source visual-spec version.

```bash
npm run visual-plan -- output/EP_001/v1/episode.json output/EP_001/audio/v1/realized_timeline.json output/EP_001/visual/v1 --visual-profile examples/visual_profile.json --series-bible examples/series_bible.json --visual-spec-version 1
```

When generating a continuity-enriched visual asset, supply the same Bible revision used for planning. The engine rejects a missing, stale, or changed Bible before calling the provider:

```bash
npm run visual-generate -- output/EP_001/visual/v1/shot_visual_spec.json output/EP_001/visual/v1/asset_manifest.json VAS_SH_001_001 --provider fake --series-bible examples/series_bible.json --overwrite-manifest
```

Reference assets are versioned records with an optional active pointer. V0.5 passes active references to the provider boundary as resolved metadata; it does not yet add image-to-image generation, animation, rendering, or publishing.

## V0.6 Motion and Compositing Contracts

V0.6 consumes the realized audio timeline, a matching V0.5 visual specification, and generated active visual assets. It produces a deterministic `MotionCompositionPlan` with renderer-agnostic canvas settings, shot timing, camera keyframes, asset-version lineage, and transition intent. It does not render a video or invoke FFmpeg.

```bash
npm run motion-plan -- output/EP_001/audio/v1/realized_timeline.json output/EP_001/visual/v1/shot_visual_spec.json output/EP_001/visual/v1/asset_manifest.json output/EP_001/motion/v1 --motion-plan-version 1
```

Every planned shot requires a `GENERATED` active PNG asset. Camera intent resolves deterministically to keyframes, while same-scene boundaries use cuts and scene changes use bounded crossfades. The plan records the exact timeline, visual-spec, manifest, asset version, and optional Series Bible revision it consumes. Rendering remains a later milestone.

## V0.7 Postproduction Composition

V0.7 assembles the V0.2 audio manifest, realized timeline, and V0.6 motion plan into a renderer-ready `FinalCompositionSpec`. Narration and dialogue retain their measured asset timing; captions follow those segments; music and camera-driven SFX remain explicit planned cues. It does not synthesize music or SFX, mix audio, burn captions, or render media.

## V0.9 Autonomous Production

The V0.9 master orchestrator chains parsing, continuity, planning, audio, visual generation, motion composition, rendering, QC, repair, and final review. It persists `.production-state.json` with deterministic input and artifact hashes, writes artifacts atomically, and resumes only from validated completed checkpoints. The legacy `production-state.json` filename is mirrored for compatibility with earlier V0.9 tooling.

The orchestrator produces a `READY_FOR_REVIEW` publishing package, but it does not publish. Publishing is a separate founder-gated lifecycle: `DRAFT -> READY_FOR_REVIEW -> APPROVED -> PUBLISHED`. Approval is bound to the package fingerprint; changing the video, metadata, visibility, schedule, captions, thumbnail, or rights evidence invalidates that approval. Rights evidence is recorded per generated asset and remains uncleared until explicitly reviewed.

V0.9 currently uses the existing partial capabilities: TTS, static image generation, deterministic motion/Ken Burns composition, and local/FFmpeg rendering. Music/SFX generation, motion-AI generation, publishing integrations, analytics feedback, and the 90-day business experiment remain future milestones described in the Master Execution Plan.

```bash
npm run postproduction-plan -- output/EP_001/audio/v1/realized_timeline.json output/EP_001/audio/v1/audio_manifest.json output/EP_001/motion/v1/motion_composition_plan.json output/EP_001/composition/v1
```
