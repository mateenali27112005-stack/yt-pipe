/**
 * V0.8 Phase 4 — Render CLI Tool
 *
 * Command-line entrypoint for the V0.8 render pipeline:
 *
 * Usage:
 *   npx tsx src/render-cli.ts <compositionPath> <audioManifestPath> <assetManifestPath> <assetRoot> <outputPath> [--overwrite] [--report-out <path>]
 *
 * Positional Arguments (required):
 *   1. compositionPath    Path to FinalCompositionSpec JSON
 *   2. audioManifestPath  Path to AudioAssetManifest JSON
 *   3. assetManifestPath  Path to Visual AssetManifest JSON
 *   4. assetRoot          Absolute root directory containing media files
 *   5. outputPath         Absolute destination .mp4 path
 *
 * Options:
 *   --overwrite           Allow overwriting existing output file
 *   --report-out <path>   Write full JSON report output to specified path
 *
 * Exit Codes:
 *   0: Successful render
 *   1: Contract error, integrity failure, or rendering failure
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeRenderPipeline } from "./render-pipeline.ts";
import { RenderError } from "./renderer-types.ts";

export async function runRenderCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const positional: string[] = [];
  let overwrite = false;
  let reportOutPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (arg === "--overwrite") {
        overwrite = true;
      } else if (arg === "--report-out") {
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          reportOutPath = args[i + 1];
          i++;
        } else {
          console.error("Error: Missing value for --report-out flag.");
          return 1;
        }
      } else {
        console.error(`Error: Unknown flag '${arg}'.`);
        printUsage();
        return 1;
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 5) {
    console.error("Error: Expected exactly 5 positional arguments.");
    printUsage();
    return 1;
  }

  const [compositionPath, audioManifestPath, assetManifestPath, assetRoot, outputPath] = positional;

  if (reportOutPath && resolve(reportOutPath) === resolve(outputPath)) {
    console.error("Error: --report-out path cannot be identical to target outputPath.");
    return 1;
  }

  try {
    const result = await executeRenderPipeline({
      compositionPath,
      audioManifestPath,
      assetManifestPath,
      assetRoot,
      outputPath,
      overwrite,
    });

    if (reportOutPath) {
      await writeFile(resolve(reportOutPath), JSON.stringify(result, null, 2) + "\n");
    }

    if (result.status === "OK") {
      console.log(JSON.stringify({
        status: "OK",
        episodeId: result.episodeId,
        compositionVersion: result.compositionVersion,
        outputPath: result.outputPath,
        renderResult: result.renderResult,
      }, null, 2));
      return 0;
    } else {
      console.error(`Render Failure: ${result.renderResult.status === "FAILED" ? result.renderResult.reason : "Pipeline failed."}`);
      return 1;
    }
  } catch (err: any) {
    console.error(`Precondition Error: ${err.message ?? err}`);
    return 1;
  }
}

function printUsage(): void {
  console.log(`
V0.8 Render CLI Usage:
  render-cli <compositionPath> <audioManifestPath> <assetManifestPath> <assetRoot> <outputPath> [--overwrite] [--report-out <path>]
`);
}

// Run CLI when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runRenderCli(process.argv).then((exitCode) => {
    if (exitCode !== 0) process.exit(exitCode);
  });
}
