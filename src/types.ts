export type Severity = "error" | "warning" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  line?: number;
  path?: string;
}

export interface Timing {
  min: number;
  target: number;
  max: number;
}

export interface ParsedShot {
  purpose?: string;
  characters: string[];
  narration?: string;
  dialogue?: string;
  visual?: string;
  timing?: Timing;
  line: number;
}

export interface ParsedScene {
  title: string;
  location?: string;
  time?: string;
  purpose?: string;
  shots: ParsedShot[];
  line: number;
}

export interface ParsedEpisode {
  title?: string;
  scenes: ParsedScene[];
}

export interface EntityRegistry {
  characters?: string[];
  locations?: string[];
}

export interface EpisodeSpec {
  schemaVersion: "0.1";
  specVersion: "1";
  lifecycle: "DRAFT" | "VALIDATED" | "PENDING_APPROVAL";
  episode: { id: string; title: string; seriesId: string };
  registry: {
    characters: Array<{ id: string; name: string }>;
    locations: Array<{ id: string; name: string }>;
  };
  scenes: Array<{
    id: string;
    order: number;
    title: string;
    location: { id: string; name: string };
    time?: string;
    purpose: string;
    shots: Array<{
      id: string;
      order: number;
      purpose: string;
      characterIds: string[];
      narration?: string;
      dialogue?: string;
      visual: string;
      plannedTiming: Timing;
    }>;
  }>;
  provenance: { parser: "episode-production-agent"; parserVersion: "0.1.0" };
}

export interface ValidationReport {
  schemaVersion: "0.1";
  status: "FAIL" | "APPROVABLE";
  generatedAt: string;
  summary: { errors: number; warnings: number; info: number };
  findings: Finding[];
  provenance: { validator: "episode-production-agent"; validatorVersion: "0.1.0" };
}
