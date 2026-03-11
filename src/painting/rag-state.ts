// Rag contamination state — CPU-side session-persistent
// Tracks accumulated K-M pigment from wiping + saturation level
// Rag gets dirtier through session; only resetRag() cleans it (new painting/session)

interface RagState {
  Kr: number;
  Kg: number;
  Kb: number;
  saturation: number;  // 0-1 paint load
}

const state: RagState = { Kr: 0, Kg: 0, Kb: 0, saturation: 0 };

export function getRagState(): Readonly<RagState> {
  return state;
}

export function resetRag() {
  state.Kr = 0;
  state.Kg = 0;
  state.Kb = 0;
  state.saturation = 0;
}

export function feedRag(Kr: number, Kg: number, Kb: number, weight: number) {
  const blend = weight * 0.3;
  state.Kr = state.Kr * (1 - blend) + Kr * blend;
  state.Kg = state.Kg * (1 - blend) + Kg * blend;
  state.Kb = state.Kb * (1 - blend) + Kb * blend;
  state.saturation = Math.min(1.0, state.saturation + weight * 0.1);
}
