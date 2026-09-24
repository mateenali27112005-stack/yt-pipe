import type { Finding, ParsedEpisode, ParsedScene, ParsedShot, Timing } from "./types.ts";

const headingEpisode = /^# Episode:\s*(.+?)\s*$/;
const headingScene = /^## Scene:\s*(.+?)\s*$/;
const headingShot = /^### Shot\s*$/;
const field = /^(Location|Time|Purpose|Narration|Dialogue|Visual|Timing):\s*(.*?)\s*$/;

export function parseStructuredMarkdown(markdown: string): { episode: ParsedEpisode; findings: Finding[] } {
  const findings: Finding[] = [];
  const episode: ParsedEpisode = { scenes: [] };
  let scene: ParsedScene | undefined;
  let shot: ParsedShot | undefined;
  let readingCharacters = false;
  let interruptedCharacterList = false;

  markdown.replace(/\r\n/g, "\n").split("\n").forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (!text) {
      interruptedCharacterList = readingCharacters;
      readingCharacters = false;
      return;
    }
    const episodeMatch = text.match(headingEpisode);
    if (episodeMatch) {
      if (episode.title) findings.push(error("DUPLICATE_EPISODE", "Only one Episode heading is allowed.", line));
      episode.title = episodeMatch[1];
      readingCharacters = false;
      return;
    }
    const sceneMatch = text.match(headingScene);
    if (sceneMatch) {
      scene = { title: sceneMatch[1], shots: [], line, seenFields: new Set() };
      episode.scenes.push(scene);
      shot = undefined;
      readingCharacters = false;
      return;
    }
    if (headingShot.test(text)) {
      if (!scene) {
        findings.push(error("SHOT_OUTSIDE_SCENE", "A Shot must be inside a Scene.", line));
        return;
      }
      shot = { characters: [], line, seenFields: new Set() };
      scene.shots.push(shot);
      readingCharacters = false;
      return;
    }
    if (readingCharacters && /^-\s+/.test(text)) {
      shot?.characters.push(text.replace(/^-\s+/, "").trim());
      return;
    }
    if (interruptedCharacterList && /^-\s+/.test(text)) {
      findings.push(error("CHARACTER_LIST_INTERRUPTED", "Character lists cannot contain blank lines.", line));
      interruptedCharacterList = false;
      return;
    }
    if (text === "Characters:") {
      if (!shot) findings.push(error("CHARACTERS_OUTSIDE_SHOT", "Characters belongs to a Shot.", line));
      else if (markField(shot, "Characters", findings, line)) readingCharacters = true;
      return;
    }
    const fieldMatch = text.match(field);
    if (fieldMatch) {
      readingCharacters = false;
      assignField(fieldMatch[1], fieldMatch[2], scene, shot, findings, line);
      return;
    }
    findings.push(error("UNRECOGNIZED_LINE", "Use the documented headings and fields; free-form prose is not accepted.", line));
    readingCharacters = false;
  });

  if (!episode.title) findings.push(error("MISSING_EPISODE", "Expected '# Episode: <title>'."));
  if (episode.scenes.length === 0) findings.push(error("MISSING_SCENE", "Expected at least one '## Scene: <title>' section."));
  return { episode, findings };
}

function assignField(name: string, value: string, scene: ParsedScene | undefined, shot: ParsedShot | undefined, findings: Finding[], line: number) {
  if (!value) {
    findings.push(error("EMPTY_FIELD", `${name} cannot be empty.`, line));
    return;
  }
  if (["Location", "Time"].includes(name)) {
    if (!scene || shot) findings.push(error("SCENE_FIELD_SCOPE", `${name} belongs before the first Shot in a Scene.`, line));
    else if (markField(scene, name, findings, line)) {
      if (name === "Location") scene.location = value;
      else scene.time = value;
    }
    return;
  }
  if (name === "Purpose" && !shot) {
    if (!scene) findings.push(error("PURPOSE_OUTSIDE_SCENE", "Purpose belongs to a Scene or Shot.", line));
    else if (markField(scene, name, findings, line)) scene.purpose = value;
    return;
  }
  if (!shot) {
    findings.push(error("SHOT_FIELD_SCOPE", `${name} belongs to a Shot.`, line));
    return;
  }
  if (!markField(shot, name, findings, line)) return;
  if (name === "Purpose") shot.purpose = value;
  else if (name === "Narration") shot.narration = value;
  else if (name === "Dialogue") shot.dialogue = value;
  else if (name === "Visual") shot.visual = value;
  else if (name === "Timing") shot.timing = parseTiming(value, findings, line);
}

function parseTiming(value: string, findings: Finding[], line: number): Timing | undefined {
  const match = value.match(/^min:\s*([0-9]+(?:\.[0-9]+)?)\s+target:\s*([0-9]+(?:\.[0-9]+)?)\s+max:\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) {
    findings.push(error("INVALID_TIMING_FORMAT", "Timing must be 'min: 3.5 target: 4.2 max: 5.0'.", line));
    return undefined;
  }
  const timing = { min: Number(match[1]), target: Number(match[2]), max: Number(match[3]) };
  if (!Object.values(timing).every(Number.isFinite)) {
    findings.push(error("INVALID_TIMING_VALUE", "Timing values must be finite numbers.", line));
    return undefined;
  }
  return timing;
}

function markField(owner: ParsedScene | ParsedShot, name: string, findings: Finding[], line: number): boolean {
  if (owner.seenFields.has(name)) {
    findings.push(error("DUPLICATE_FIELD", `${name} may appear only once in this section.`, line));
    return false;
  }
  owner.seenFields.add(name);
  return true;
}

function error(code: string, message: string, line?: number): Finding {
  return { code, severity: "error", message, line };
}
