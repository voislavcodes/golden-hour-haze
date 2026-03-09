// Layer parameter interfaces

export interface DepthFieldParams {
  nearPlane: number;     // 0-1
  farPlane: number;      // 0-1
  noiseScale: number;    // FBM frequency
  noiseStrength: number; // FBM amplitude
  controlPoints: Float32Array; // xy pairs, max 16 points
  controlCount: number;
}

export interface AtmosphereParams {
  density: number;       // 0-1
  warmth: number;        // -1 to 1 (cool to warm)
  grain: number;         // 0-1 grain intensity
  scatter: number;       // 0-1 scatter amount
  driftX: number;        // drift field direction
  driftY: number;
  driftSpeed: number;
  turbulence: number;    // 0-1
  grainAngle: number;    // radians, rotates grain texture
  grainDepth: number;    // 0-1, grain persistence with depth
}

export interface FormDef {
  type: number;          // 0=circle, 1=box, 2=line
  x: number;
  y: number;
  sizeX: number;
  sizeY: number;
  rotation: number;
  softness: number;
  depth: number;         // 0-1
  colorIndex: number;    // palette index
  opacity: number;
  dissolution?: number;  // legacy, now handled by dissolution texture
  strokeDirX: number;    // normalized stroke direction
  strokeDirY: number;
  taper: number;         // end/start radius ratio for type=3 (0=needle, 1=uniform, >1=flaring)
}

export interface LightDef {
  x: number;             // 0-1
  y: number;             // 0-1
  coreRadius: number;    // default 0.02
  bloomRadius: number;   // default 0.08
  intensity: number;     // 0.05-1.0, default 0.6
  aspectRatio: number;   // 1.0=circle, >1=tall, <1=wide
  rotation: number;      // radians
  paletteSlot: number;   // -1=auto from TIME, 0-4=locked
  colorR: number;        // resolved color (computed before GPU upload)
  colorG: number;
  colorB: number;
  depth: number;         // 0.5 default
}

export interface TonalMapParams {
  enabled: boolean;
  valueRange: number;
  keyValue: number;
  contrast: number;
}

export interface AnchorPoint {
  x: number;
  y: number;
  chromaBoost: number;
  muteFalloff: number;
}

export interface CompositorParams {
  shadowChroma: number;   // 0-1
  grayscale: number;      // 0 or 1
  anchorX: number;
  anchorY: number;
  anchorBoost: number;
  anchorFalloff: number;
  sunGradeWarmth: number;    // -1 cool to 1 warm
  sunGradeIntensity: number; // 0 to 1
}

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  a: number; // spectral coefficient placeholder
}

export interface PaletteState {
  colors: PaletteColor[];
  activeIndex: number;
}

export const MAX_FORMS = 1024;
export const MAX_LIGHTS = 16;
export const MAX_PALETTE_COLORS = 8;

// GPU buffer sizes (bytes)
export const FORM_STRIDE = 64; // 16 floats
export const LIGHT_STRIDE = 48; // 12 floats
export const FORM_BUFFER_SIZE = MAX_FORMS * FORM_STRIDE;
export const LIGHT_BUFFER_SIZE = MAX_LIGHTS * 48; // padded
