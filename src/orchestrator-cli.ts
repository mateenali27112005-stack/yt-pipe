#!/usr/bin/env node

/**
 * V0.9 Master Orchestrator CLI
 *
 * Runs the autonomous production pipeline.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { MasterOrchestrator } from "./orchestrator.ts";
import { createOpenAiSpeechProvider } from "./providers/openai-tts.ts";
import { createOpenAiImageProvider } from "./providers/openai-image.ts";
import { createInitialState } from "./continuity.ts";
import { loadDotEnv } from "./env.ts";
import type { SeriesBible } from "./types.ts";

export async function runOrchestratorCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length < 6) {
    console.error("Usage: agy-orchestrator <runId> <seriesId> <episodeId> <scriptPath> <biblePath> <workingDir>");
    return 1;
  }

  const [runId, seriesId, episodeId, scriptPath, biblePath, workingDir] = args;

  try {
    await loadDotEnv();
    const scriptStr = await readFile(resolve(scriptPath), "utf8");
    const bibleStr = await readFile(resolve(biblePath), "utf8");
    const bible = JSON.parse(bibleStr) as SeriesBible;

    const speechProvider = createOpenAiSpeechProvider();
    const imageProvider = createOpenAiImageProvider();

    const orchestrator = new MasterOrchestrator(runId, seriesId, episodeId, {
      speechProvider,
      imageProvider,
      bible,
      initialContinuityState: createInitialState(seriesId, bible),
      workingDirectory: resolve(workingDir)
    });

    const result = await orchestrator.run(scriptStr);

    console.log(JSON.stringify(result, null, 2));
    
    if (result.status === "FAILED") {
      console.error("Production run failed.");
      return 1;
    } else if (result.status === "NEEDS_HUMAN_REVIEW") {
      console.warn("Production run halted, requires human review.");
      return 2;
    }

    console.log("Production run completed successfully.");
    return 0;
  } catch (err) {
    console.error("Fatal orchestrator error:", err);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOrchestratorCli(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
