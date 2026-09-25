import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDotEnv } from "../src/env.ts";

test("loadDotEnv reads local values without overriding exported values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v09-env-"));
  const key = "V09_TEST_DOTENV_VALUE";
  const previous = process.env[key];
  try {
    await writeFile(join(directory, ".env"), `${key}=from-file\nV09_TEST_QUOTED=\"quoted value\"\n`, "utf8");
    delete process.env[key];
    delete process.env.V09_TEST_QUOTED;
    await loadDotEnv(join(directory, ".env"));
    assert.equal(process.env[key], "from-file");
    assert.equal(process.env.V09_TEST_QUOTED, "quoted value");

    process.env[key] = "from-shell";
    await loadDotEnv(join(directory, ".env"));
    assert.equal(process.env[key], "from-shell");
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    delete process.env.V09_TEST_QUOTED;
    await rm(directory, { recursive: true, force: true });
  }
});
