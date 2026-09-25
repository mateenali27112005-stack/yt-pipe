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
  seenFields: Set<string>;
}

export interface ParsedScene {
  title: string;
  location?: string;
  time?: string;
  purpose?: string;
  shots: ParsedShot[];
  line: number;
  seenFields: Set<string>;
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
  specVersion: number;
  parentSpecVersion?: number;
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

export interface AudioVoiceRegistry {
  narrator: string;
  characters?: Record<string, string>;
}

export interface AudioAssetManifest {
  schemaVersion: "0.1";
  episodeId: string;
  sourceSpecVersion: number;
  generatedAt: string;
  provider: "macos-say";
  assets: Array<{
    id: string;
    segmentId: string;
    shotId: string;
    role: "narration" | "dialogue";
    voice: string;
    path: string;
    format: "aiff";
    durationSeconds: number;
  }>;
}

export interface RealizedTimeline {
  schemaVersion: "0.1";
  timelineVersion: number;
  episodeId: string;
  sourceSpecVersion: number;
  generatedAt: string;
  totalDurationSeconds: number;
  segments: Array<{
    id: string;
    shotId: string;
    role: "narration" | "dialogue";
    speaker?: string;
    text: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    audioAssetId: string;
  }>;
}

export interface VisualProfile {
  styleReference: string;
  defaultLighting: string;
  defaultMood: string;
  defaultCameraIntent: string;
}

export interface ReferenceAsset {
  id: string;
  version: number;
  path: string;
  sha256?: string;
}

export interface SeriesBible {
  schemaVersion: "0.1";
  bibleVersion: number;
  seriesId: string;
  generatedAt: string;
  characters: Array<{
    id: string;
    name: string;
    appearance: { hair: string; eyes: string; build: string; clothing: string };
    personalityVisualCues: string[];
    referenceAssets: ReferenceAsset[];
    activeReferenceAssetId?: string;
  }>;
  locations: Array<{
    id: string;
    name: string;
    visualDescription: string;
    referenceAssets: ReferenceAsset[];
    activeReferenceAssetId?: string;
  }>;
  visualStyles: Array<{
    id: string;
    name: string;
    promptGuidance: string;
    negativePrompt?: string;
  }>;
}

export interface ResolvedVisualContext {
  characterReferences: Array<{
    id: string;
    name: string;
    appearance: { hair: string; eyes: string; build: string; clothing: string };
    personalityVisualCues: string[];
    activeReferenceAsset?: ReferenceAsset;
  }>;
  locationReference: {
    id: string;
    name: string;
    visualDescription: string;
    activeReferenceAsset?: ReferenceAsset;
  };
  styleReference: { id: string; name: string; promptGuidance: string; negativePrompt?: string };
  sourceHash: string;
}

export interface ShotVisualSpec {
  schemaVersion: "0.1";
  visualSpecVersion: number;
  episodeId: string;
  sourceSpecVersion: number;
  sourceTimelineVersion: number;
  sourceSeriesBibleVersion?: number;
  generatedAt: string;
  shots: Array<{
    id: string;
    sceneId: string;
    shotId: string;
    characterIds: string[];
    locationId: string;
    visualIntent: string;
    framing: string;
    action: string;
    expression: string;
    lighting: string;
    mood: string;
    cameraIntent: string;
    styleReference: string;
    continuity?: ResolvedVisualContext;
    realizedTiming?: { startSeconds: number; endSeconds: number; durationSeconds: number };
    sourceHash: string;
  }>;
}

export interface AssetManifest {
  schemaVersion: "0.1";
  manifestRevision: number;
  episodeId: string;
  sourceSpecVersion: number;
  sourceVisualSpecVersion: number;
  sourceSeriesBibleVersion?: number;
  generatedAt: string;
  assets: Array<{
    id: string;
    shotId: string;
    shotVisualSpecId: string;
    activeVersionId: string;
    versions: Array<{
      id: string;
      version: number;
      lifecycle: "PLANNED" | "GENERATED";
      createdAt: string;
      supersedesVersionId?: string;
      output?: {
        path: string;
        format: "png";
        byteLength: number;
        sha256: string;
      };
      provider?: {
        name: string;
        model: string;
        promptHash: string;
        revisedPrompt?: string;
      };
    }>;
  }>;
}

export interface MotionCompositionPlan {
  schemaVersion: "0.1";
  motionPlanVersion: number;
  episodeId: string;
  sourceSpecVersion: number;
  sourceTimelineVersion: number;
  sourceVisualSpecVersion: number;
  sourceAssetManifestRevision: number;
  sourceSeriesBibleVersion?: number;
  generatedAt: string;
  canvas: { width: number; height: number; frameRate: number };
  shots: Array<{
    id: string;
    sceneId: string;
    shotId: string;
    visualAsset: { assetId: string; assetVersionId: string; path: string; sha256: string };
    timing: { startSeconds: number; endSeconds: number; durationSeconds: number };
    camera: {
      intent: string;
      keyframes: Array<{ offset: 0 | 1; scale: number; x: number; y: number }>;
    };
    transitionIn?: { type: "CUT" | "CROSSFADE"; atSeconds: number; durationSeconds: number };
    sourceHash: string;
  }>;
}

export interface FinalCompositionSpec {
  schemaVersion: "0.1";
  compositionVersion: number;
  episodeId: string;
  sourceSpecVersion: number;
  sourceTimelineVersion: number;
  sourceMotionPlanVersion: number;
  sourceAssetManifestRevision: number;
  generatedAt: string;
  durationSeconds: number;
  visualComposition: {
    canvas: MotionCompositionPlan["canvas"];
    shots: MotionCompositionPlan["shots"];
  };
  narrationDialogueTracks: Array<{ id: string; audioAssetId: string; path: string; role: "narration" | "dialogue"; startSeconds: number; endSeconds: number; gainDb: number }>;
  musicCues: Array<{ id: string; lifecycle: "PLANNED"; startSeconds: number; endSeconds: number; style: string; gainDb: number }>;
  sfxCues: Array<{ id: string; lifecycle: "PLANNED"; shotId: string; startSeconds: number; endSeconds: number; description: string; gainDb: number }>;
  captions: Array<{ id: string; role: "narration" | "dialogue"; speaker?: string; text: string; startSeconds: number; endSeconds: number }>;
  sourceHash: string;
}
