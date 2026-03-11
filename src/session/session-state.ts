// Session flow state machine — prepare / test / paint
import { createStore } from '../state/store.js';

export type SessionPhase = 'prepare' | 'test' | 'paint';

export interface SessionState {
  phase: SessionPhase;
  moodIndex: number;
  brushAges: number[];     // 5 slots: 0=new, 0.5=worn, 1.0=old
  bristleSeeds: number[];  // 5 slots: random per session
}

export const sessionStore = createStore<SessionState>({
  phase: 'prepare',
  moodIndex: 0,
  brushAges: [0.0, 0.5, 0.5, 1.0, 1.0],   // Detail=NEW, Small=WORN, Medium=WORN, Large=OLD, Wash=OLD
  bristleSeeds: Array.from({ length: 5 }, () => Math.random()),
});

export function advancePhase() {
  const { phase } = sessionStore.get();
  switch (phase) {
    case 'prepare':
      sessionStore.set({ phase: 'test' });
      break;
    case 'test':
      sessionStore.set({
        phase: 'paint',
        bristleSeeds: Array.from({ length: 5 }, () => Math.random()),
      });
      break;
  }
}

export function retreatPhase() {
  const { phase } = sessionStore.get();
  switch (phase) {
    case 'test':
      sessionStore.set({ phase: 'prepare' });
      break;
  }
}

export function resetToPrepare() {
  sessionStore.set({
    phase: 'prepare',
    moodIndex: 0,
    brushAges: [0.0, 0.5, 0.5, 1.0, 1.0],
    bristleSeeds: Array.from({ length: 5 }, () => Math.random()),
  });
}
