import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore } from '../state/ui-state.js';
import { sessionStore, type SessionPhase } from '../session/session-state.js';
import { setBrushSlotAge } from '../painting/palette.js';

const CIRCLE_SIZES = [12, 18, 24, 32, 40];
const AGE_VALUES = [0.0, 0.5, 1.0] as const;
const AGE_LABELS = ['NEW', 'WORN', 'OLD'] as const;

@customElement('ghz-brush-selector')
export class BrushSelector extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 68px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100;
        pointer-events: auto;
      }

      :host([hidden]) {
        display: none;
      }

      .container {
        display: flex;
        gap: 6px;
        padding: 6px 10px;
        align-items: flex-end;
      }

      .slot {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 3px;
        cursor: pointer;
      }

      .circle {
        border-radius: 50%;
        border: 2px solid var(--ghz-glass-border);
        background: rgba(30, 25, 40, 0.4);
        transition: border-color var(--ghz-transition),
                    box-shadow var(--ghz-transition);
      }

      .circle.active {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 10px rgba(232, 168, 64, 0.3);
      }

      .circle:hover:not(.active) {
        border-color: rgba(255, 200, 120, 0.4);
      }

      .age-badge {
        font-size: 7px;
        font-weight: 500;
        letter-spacing: 0.5px;
        opacity: 0.35;
        cursor: pointer;
        padding: 1px 3px;
        border-radius: 3px;
        transition: opacity var(--ghz-transition),
                    color var(--ghz-transition);
        user-select: none;
      }

      .slot.active .age-badge {
        opacity: 0.8;
        color: var(--ghz-accent);
      }

      .age-badge:hover:not(.locked) {
        opacity: 0.7;
      }

      .age-badge.locked {
        opacity: 0.2;
        cursor: default;
      }
    `,
  ];

  @state() private _activeSlot = 2;
  @state() private _phase: SessionPhase = 'prepare';
  @state() private _brushAges: number[] = [0, 0.5, 0.5, 1.0, 1.0];

  private _unsubs: Array<() => void> = [];

  connectedCallback() {
    super.connectedCallback();
    this._activeSlot = uiStore.get().activeBrushSlot;
    const session = sessionStore.get();
    this._phase = session.phase;
    this._brushAges = [...session.brushAges];

    this._unsubs.push(
      uiStore.select((s) => s.activeBrushSlot, (slot) => { this._activeSlot = slot; }),
      sessionStore.select((s) => s.phase, (phase) => { this._phase = phase; }),
      sessionStore.select((s) => s.brushAges, (ages) => { this._brushAges = [...ages]; }),
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
  }

  private _selectSlot(i: number) {
    uiStore.set({ activeBrushSlot: i });
  }

  private _cycleAge(slotIndex: number) {
    if (this._phase !== 'test') return;
    const nextIdx = (this._ageIndex(slotIndex) + 1) % AGE_VALUES.length;
    const ages = [...this._brushAges];
    ages[slotIndex] = AGE_VALUES[nextIdx];
    sessionStore.set({ brushAges: ages });
    setBrushSlotAge(slotIndex, AGE_VALUES[nextIdx]);
  }

  private _ageIndex(slotIndex: number): number {
    const age = this._brushAges[slotIndex] ?? 0;
    if (age <= 0.25) return 0;
    if (age <= 0.75) return 1;
    return 2;
  }

  render() {
    if (this._phase === 'prepare') {
      return nothing;
    }

    const locked = this._phase === 'paint';

    return html`
      <div class="container glass">
        ${CIRCLE_SIZES.map((size, i) => {
          const active = this._activeSlot === i;
          const currentAgeIdx = this._ageIndex(i);

          return html`
            <div class="slot ${active ? 'active' : ''}" @click=${() => this._selectSlot(i)}>
              <div
                class="circle ${active ? 'active' : ''}"
                style="width:${size}px;height:${size}px"
              ></div>
              <span
                class="age-badge ${locked ? 'locked' : ''}"
                @click=${(e: Event) => { e.stopPropagation(); this._cycleAge(i); }}
              >${AGE_LABELS[currentAgeIdx]}</span>
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-brush-selector': BrushSelector;
  }
}
