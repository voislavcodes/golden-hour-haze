import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore } from '../state/ui-state.js';
import { sessionStore, type SessionPhase } from '../session/session-state.js';
import { BRUSH_SLOT_NAMES } from '../painting/palette.js';
import { setBrushSlotAge } from '../painting/palette.js';

const CIRCLE_SIZES = [12, 18, 24, 32, 40];
const AGE_VALUES = [0.0, 0.5, 1.0] as const;
const AGE_LABELS = ['N', 'W', 'O'] as const;

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
        align-items: center;
      }

      .slot {
        display: flex;
        flex-direction: column;
        align-items: center;
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

      .age-dots {
        display: flex;
        gap: 3px;
        align-items: center;
      }

      .age-dot {
        border-radius: 50%;
        border: 1px solid var(--ghz-glass-border);
        background: transparent;
        transition: background var(--ghz-transition),
                    border-color var(--ghz-transition);
        cursor: pointer;
        padding: 0;
      }

      .age-dot.age-0 { width: 4px; height: 4px; }
      .age-dot.age-1 { width: 6px; height: 6px; }
      .age-dot.age-2 { width: 8px; height: 8px; }

      .age-dot.current {
        background: var(--ghz-accent);
        border-color: var(--ghz-accent);
      }

      .age-dot.locked {
        opacity: 0.3;
        cursor: default;
      }

      .age-dot:hover:not(.locked):not(.current) {
        border-color: rgba(255, 200, 120, 0.5);
        background: rgba(232, 168, 64, 0.3);
      }

      .label {
        font-size: 8px;
        opacity: 0.4;
        font-weight: 400;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .slot.active .label {
        opacity: 0.8;
        color: var(--ghz-accent);
      }
    `,
  ];

  @state() private _activeSlot = 2;
  @state() private _phase: SessionPhase = 'prepare-mood';
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

  private _setAge(slotIndex: number, age: number) {
    if (this._phase !== 'test') return;
    const ages = [...this._brushAges];
    ages[slotIndex] = age;
    sessionStore.set({ brushAges: ages });
    setBrushSlotAge(slotIndex, age);
  }

  private _ageIndex(slotIndex: number): number {
    const age = this._brushAges[slotIndex] ?? 0;
    if (age <= 0.25) return 0;
    if (age <= 0.75) return 1;
    return 2;
  }

  render() {
    if (this._phase === 'prepare-mood' || this._phase === 'prepare-surface') {
      return nothing;
    }

    const locked = this._phase === 'paint';

    return html`
      <div class="container glass">
        ${BRUSH_SLOT_NAMES.map((name, i) => {
          const active = this._activeSlot === i;
          const size = CIRCLE_SIZES[i];
          const currentAgeIdx = this._ageIndex(i);

          return html`
            <div class="slot ${active ? 'active' : ''}" @click=${() => this._selectSlot(i)}>
              <div
                class="circle ${active ? 'active' : ''}"
                style="width:${size}px;height:${size}px"
              ></div>
              <div class="age-dots">
                ${AGE_VALUES.map((ageVal, ai) => html`
                  <div
                    class="age-dot age-${ai} ${currentAgeIdx === ai ? 'current' : ''} ${locked ? 'locked' : ''}"
                    title="${AGE_LABELS[ai]}"
                    @click=${(e: Event) => { e.stopPropagation(); this._setAge(i, ageVal); }}
                  ></div>
                `)}
              </div>
              <span class="label">${name[0]}</span>
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
