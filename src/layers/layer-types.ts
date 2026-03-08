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
  dissolution: number;   // 0-1
  strokeDirX: number;    // normalized stroke direction
  strokeDirY: number;
  taper: number;         // end/start radius ratio for type=3 (0=needle, 1=uniform, >1=flaring)
}

export interface LightDef {
  x: number;
  y: number;
  depth: number;
  intensity: number;
  radius: number;
  colorR: number;
  colorG: number;
  colorB: number;
  scatter: number;
  scaleX: number;      // elliptical X scale (default 1)
  scaleY: number;      // elliptical Y scale (default 1)
  rotation: number;    // ellipse rotation in radians (default 0)
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

export const MAX_FORMS = 64;
export const MAX_LIGHTS = 16;
export const MAX_PALETTE_COLORS = 8;

// GPU buffer sizes (bytes)
export const FORM_STRIDE = 64; // 16 floats
export const LIGHT_STRIDE = 36; // 9 floats padded to 40
export const FORM_BUFFER_SIZE = MAX_FORMS * FORM_STRIDE;
export const LIGHT_BUFFER_SIZE = MAX_LIGHTS * 48; // padded
