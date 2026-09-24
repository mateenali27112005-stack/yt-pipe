# Episode Production Agent V0.1

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
