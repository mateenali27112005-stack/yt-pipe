# Episode Production Agent V0.1

The V0.1 brain skeleton compiles strict structured Markdown into an immutable EpisodeSpec and a separate validation report. It is deterministic, contains no provider integrations, and keeps story intent separate from runtime state and generated files.

## Run

```bash
npm run parse -- examples/episode_001.md output
```

Optional registry validation:

```bash
npm run parse -- examples/episode_001.md output --series-bible examples/series_bible.json --series-id SERIES_AWAKENING
```

The command writes `episode.json` and `validation.json`. It exits with code `1` when blocking validation errors are present.

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
