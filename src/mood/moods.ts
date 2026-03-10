// Mood presets — each mood defines 15 pile colors (5 hues × 3 values) + atmosphere
// Replaces interactive atmosphere controls with curated presets

export interface KColor {
  r: number;
  g: number;
  b: number;
}

export interface MoodPile {
  light: KColor;
  medium: KColor;
  dark: KColor;
}

export interface Mood {
  name: string;
  description: string;
  density: number;       // atmosphere density 0-1
  sunAngle: number;      // fixed sun position
  sunElevation: number;  // fixed sun elevation
  horizonY: number;      // fixed horizon
  warmth: number;        // atmosphere warmth -1 to 1
  piles: MoodPile[];     // 5 hues, each with light/medium/dark
  defaultSurface: string;
}

function hex(h: string): KColor {
  const v = parseInt(h.replace('#', ''), 16);
  return {
    r: ((v >> 16) & 0xff) / 255,
    g: ((v >> 8) & 0xff) / 255,
    b: (v & 0xff) / 255,
  };
}

function pile(light: string, medium: string, dark: string): MoodPile {
  return { light: hex(light), medium: hex(medium), dark: hex(dark) };
}

export const MOODS: Mood[] = [
  {
    name: 'Golden Hour',
    description: 'Warm amber light, long shadows, rich contrast',
    density: 0.35,
    sunAngle: 1.28,
    sunElevation: 0.15,
    horizonY: 0.5,
    warmth: 0.6,
    piles: [
      pile('#f5dfc0', '#d4993a', '#6b4420'),  // warm gold
      pile('#f0c8a8', '#c75e30', '#5a2210'),  // burnt orange
      pile('#d8c0d0', '#8a4870', '#3a1830'),  // muted mauve
      pile('#b8c8e0', '#3a5a8a', '#152840'),  // twilight blue
      pile('#f0ebe0', '#c8b898', '#5a5040'),  // warm cream
    ],
    defaultSurface: 'board',
  },
  {
    name: 'Blue Hour',
    description: 'Deep blue twilight, cool shadows, muted warmth',
    density: 0.45,
    sunAngle: 0.4,
    sunElevation: -0.05,
    horizonY: 0.45,
    warmth: -0.3,
    piles: [
      pile('#c8d0e8', '#5070a0', '#1a2848'),  // steel blue
      pile('#d0c0d8', '#7050a0', '#2a1848'),  // lavender
      pile('#e0d0c0', '#a07850', '#403020'),  // warm ochre
      pile('#c0d8d0', '#408070', '#103830'),  // teal
      pile('#d8d4d0', '#8a8688', '#383438'),  // cool grey
    ],
    defaultSurface: 'canvas',
  },
  {
    name: 'Foggy Morning',
    description: 'Dense haze, low contrast, diffused light',
    density: 0.75,
    sunAngle: 1.0,
    sunElevation: 0.08,
    horizonY: 0.55,
    warmth: 0.1,
    piles: [
      pile('#e8e4e0', '#b8afa8', '#585048'),  // warm mist
      pile('#e0dcd8', '#989088', '#484038'),  // cool stone
      pile('#e0e0d8', '#a0a890', '#404838'),  // sage
      pile('#dce0e4', '#8898a8', '#303848'),  // blue haze
      pile('#e8e0d8', '#c0a890', '#584830'),  // sand
    ],
    defaultSurface: 'paper',
  },
  {
    name: 'Midday Haze',
    description: 'Bright overhead light, washed-out, minimal shadow',
    density: 0.25,
    sunAngle: 1.57,
    sunElevation: 0.45,
    horizonY: 0.5,
    warmth: 0.15,
    piles: [
      pile('#f8f0e0', '#d8c080', '#786838'),  // bleached gold
      pile('#f0e8e0', '#c0a080', '#685038'),  // warm tan
      pile('#e8e0f0', '#9080b0', '#403060'),  // dusty violet
      pile('#e0e8f0', '#7898c0', '#284068'),  // sky blue
      pile('#f0f0e8', '#d0d0c0', '#686860'),  // light neutral
    ],
    defaultSurface: 'smooth',
  },
  {
    name: 'Dusk',
    description: 'Deep warm-to-cool transition, saturated bands',
    density: 0.4,
    sunAngle: 0.8,
    sunElevation: 0.02,
    horizonY: 0.48,
    warmth: 0.35,
    piles: [
      pile('#f0c0a0', '#c06030', '#582010'),  // fiery orange
      pile('#e8a0b0', '#a04060', '#481028'),  // rose
      pile('#c8b0d8', '#6840a0', '#281848'),  // deep violet
      pile('#a0b8d8', '#305090', '#101838'),  // navy
      pile('#e0d0c0', '#a08868', '#483828'),  // dusk earth
    ],
    defaultSurface: 'board',
  },
  {
    name: 'Overcast',
    description: 'Flat diffuse light, subtle color, even values',
    density: 0.55,
    sunAngle: 1.2,
    sunElevation: 0.2,
    horizonY: 0.52,
    warmth: -0.1,
    piles: [
      pile('#dcdcd8', '#98988a', '#404038'),  // grey green
      pile('#d8d4d0', '#888078', '#383028'),  // warm grey
      pile('#d0d4d8', '#707888', '#282830'),  // cool slate
      pile('#d8dcd0', '#809070', '#303828'),  // olive
      pile('#e0dcd8', '#b0a898', '#504840'),  // putty
    ],
    defaultSurface: 'canvas',
  },
  {
    name: 'Night',
    description: 'Deep darkness, punctuated by artificial light',
    density: 0.6,
    sunAngle: 0.2,
    sunElevation: -0.25,
    horizonY: 0.5,
    warmth: -0.4,
    piles: [
      pile('#484050', '#201828', '#0a0810'),  // night violet
      pile('#585058', '#302830', '#100810'),  // dark mauve
      pile('#d8c898', '#a08050', '#483818'),  // lamplight gold
      pile('#404858', '#181828', '#080810'),  // midnight blue
      pile('#504840', '#282018', '#100c08'),  // dark earth
    ],
    defaultSurface: 'smooth',
  },
];

export function getMood(name: string): Mood | undefined {
  return MOODS.find(m => m.name === name);
}

export function getMoodByIndex(index: number): Mood {
  return MOODS[Math.max(0, Math.min(MOODS.length - 1, index))];
}
