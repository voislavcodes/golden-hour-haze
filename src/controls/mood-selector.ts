// Mood selection UI — full-screen card layout for choosing mood presets
import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { type Mood, type KColor } from '../mood/moods.js';
import { getAllMoods, loadCustomMoods } from '../mood/custom-moods.js';
import { sessionStore, advancePhase, retreatPhase, resetToPrepareMood, type SessionPhase } from '../session/session-state.js';
import { sceneStore } from '../state/scene-state.js';
import { deriveAtmosphere } from '../mood/derive-atmosphere.js';
import './mood-creator.js';
import type { MoodCreator } from './mood-creator.js';
import './material-selector.js';
import { getMaterial } from '../surface/materials.js';
import type { MaterialType } from '../state/scene-state.js';

function colorToCSS(c: KColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

@customElement('ghz-mood-selector')
export class MoodSelector extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        transition: opacity 0.3s;
        pointer-events: none;
      }

      :host(.overlay) {
        background: rgba(5, 3, 10, 0.92);
        pointer-events: auto;
      }

      :host([hidden]) {
        display: none;
      }

      .title {
        font-size: 16px;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: var(--ghz-text-dim);
        margin-bottom: 24px;
      }

      .grid {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        max-width: 720px;
        justify-content: center;
      }

      .card {
        width: 150px;
        padding: 12px;
        cursor: pointer;
        transition: border-color 0.2s, box-shadow 0.2s;
      }

      .card:hover {
        border-color: rgba(255, 200, 120, 0.4);
      }

      .card.selected {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 16px rgba(232, 168, 64, 0.25);
      }

      .sky-preview {
        width: 100%;
        height: 32px;
        border-radius: 4px;
        margin-bottom: 8px;
      }

      .piles {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 3px;
        margin-bottom: 8px;
      }

      .pile-column {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .pile-swatch {
        width: 100%;
        height: 12px;
        border-radius: 2px;
      }

      .card-name {
        font-size: 11px;
        text-align: center;
        letter-spacing: 0.5px;
        color: var(--ghz-text);
      }

      .card-desc {
        font-size: 9px;
        text-align: center;
        color: var(--ghz-text-dim);
        margin-top: 4px;
      }

      .actions {
        margin-top: 24px;
        display: flex;
        gap: 12px;
      }

      .action-btn {
        padding: 10px 28px;
        font-size: 12px;
        letter-spacing: 1px;
        text-transform: uppercase;
      }

      .phase-label {
        font-size: 10px;
        letter-spacing: 1px;
        text-transform: uppercase;
        color: var(--ghz-text-dim);
        margin-bottom: 8px;
      }

      /* Surface selection sub-phase */
      .surface-grid {
        display: flex;
        gap: 8px;
        margin-top: 16px;
      }

      .surface-btn {
        padding: 8px 20px;
        font-size: 11px;
        letter-spacing: 0.5px;
      }

      /* Test/paint phase controls */
      .session-bar {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1001;
        display: flex;
        gap: 8px;
        align-items: center;
        pointer-events: auto;
      }

      .session-btn {
        padding: 6px 16px;
        font-size: 10px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .session-label {
        font-size: 10px;
        letter-spacing: 1px;
        color: var(--ghz-text-dim);
        text-transform: uppercase;
        padding: 0 8px;
      }
    `,
  ];

  @state() private _phase: SessionPhase = 'prepare-mood';
  @state() private _selectedMood = 0;
  @state() private _confirmingPaint = false;
  @state() private _confirmingNew = false;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    loadCustomMoods();
    const s = sessionStore.get();
    this._phase = s.phase;
    this._selectedMood = s.moodIndex;
    this._updateOverlayClass();
    this._unsubscribe = sessionStore.subscribe((state) => {
      this._phase = state.phase;
      this._selectedMood = state.moodIndex;
    });
    this.addEventListener('mood-created', () => {
      this.requestUpdate();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _updateOverlayClass() {
    const isOverlay = this._phase === 'prepare-mood' || this._phase === 'prepare-surface';
    this.classList.toggle('overlay', isOverlay);
  }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('_phase')) {
      this._updateOverlayClass();
    }
  }

  private _selectMood(index: number) {
    sessionStore.set({ moodIndex: index });
    const moods = getAllMoods();
    if (index < moods.length) {
      this._applyMoodPreview(moods[index]);
    }
  }

  private _openCreator() {
    const creator = this.renderRoot.querySelector('ghz-mood-creator') as MoodCreator | null;
    creator?.show();
  }

  private _applyMoodPreview(mood: Mood) {
    const atmosphere = deriveAtmosphere(mood);
    const materialType = (mood.defaultSurface || 'board') as MaterialType;
    const mat = getMaterial(materialType);
    sceneStore.update((s) => ({
      mood: mood.name,
      atmosphere,
      sunAngle: mood.sunAngle,
      sunElevation: mood.sunElevation,
      horizonY: mood.horizonY,
      surface: {
        ...s.surface,
        material: materialType,
        absorption: mat.absorption,
        drySpeed: mat.drySpeed,
      },
    }));
  }

  private _confirmMood() {
    advancePhase();
  }

  private _confirmSurface() {
    advancePhase();
  }

  private _startPainting() {
    if (!this._confirmingPaint) {
      this._confirmingPaint = true;
      return;
    }
    this._confirmingPaint = false;
    advancePhase();
    // Dispatch clear event — app.ts will clear the accum texture
    this.dispatchEvent(new CustomEvent('start-painting', { bubbles: true, composed: true }));
  }

  private _cancelStartPainting() {
    this._confirmingPaint = false;
  }

  private _back() {
    retreatPhase();
  }

  private _newPainting() {
    if (!this._confirmingNew) {
      this._confirmingNew = true;
      return;
    }
    this._confirmingNew = false;
    resetToPrepareMood();
    this.dispatchEvent(new CustomEvent('new-painting', { bubbles: true, composed: true }));
  }

  private _cancelNew() {
    this._confirmingNew = false;
  }

  private _renderSkyGradient(mood: Mood): string {
    // Approximate sky gradient from mood's lightest warm and cool hues
    const warmLight = mood.piles[0].light;
    const coolLight = mood.piles[3].light;
    return `linear-gradient(to top, ${colorToCSS(warmLight)}, ${colorToCSS(coolLight)})`;
  }

  render() {
    // Full-screen overlay for mood & surface selection
    if (this._phase === 'prepare-mood') {
      const moods = getAllMoods();
      return html`
        <span class="phase-label">choose a mood</span>
        <div class="grid">
          ${moods.map((mood, i) => html`
            <div class="card glass ${this._selectedMood === i ? 'selected' : ''}"
                 @click=${() => this._selectMood(i)}>
              <div class="sky-preview" style="background: ${this._renderSkyGradient(mood)}"></div>
              <div class="piles">
                ${mood.piles.map(pile => html`
                  <div class="pile-column">
                    <div class="pile-swatch" style="background: ${colorToCSS(pile.light)}"></div>
                    <div class="pile-swatch" style="background: ${colorToCSS(pile.medium)}"></div>
                    <div class="pile-swatch" style="background: ${colorToCSS(pile.dark)}"></div>
                  </div>
                `)}
              </div>
              <div class="card-name">${mood.name}</div>
              <div class="card-desc">${mood.description}</div>
            </div>
          `)}
        </div>
        <div class="actions">
          <button class="glass-button action-btn" @click=${this._openCreator}>create custom</button>
          <button class="glass-button action-btn" @click=${this._confirmMood}>next</button>
        </div>
        <ghz-mood-creator></ghz-mood-creator>
      `;
    }

    if (this._phase === 'prepare-surface') {
      return html`
        <span class="phase-label">choose a surface</span>
        <ghz-material-selector></ghz-material-selector>
        <div class="actions">
          <button class="glass-button action-btn" @click=${this._back}>back</button>
          <button class="glass-button action-btn" @click=${this._confirmSurface}>test canvas</button>
        </div>
      `;
    }

    // Test phase: minimal bar at top
    if (this._phase === 'test') {
      return html`
        <div class="session-bar">
          <button class="glass-button session-btn" @click=${this._back}>back</button>
          <span class="session-label">test canvas</span>
          ${this._confirmingPaint ? html`
            <span class="session-label" style="color: var(--ghz-accent)">clear test canvas?</span>
            <button class="glass-button session-btn" @click=${this._startPainting}>yes, start</button>
            <button class="glass-button session-btn" @click=${this._cancelStartPainting}>cancel</button>
          ` : html`
            <button class="glass-button session-btn active" @click=${this._startPainting}>start painting</button>
          `}
        </div>
      `;
    }

    // Paint phase: minimal bar
    if (this._phase === 'paint') {
      return html`
        <div class="session-bar">
          <span class="session-label">painting</span>
          ${this._confirmingNew ? html`
            <span class="session-label" style="color: var(--ghz-accent)">start new painting?</span>
            <button class="glass-button session-btn" @click=${this._newPainting}>yes</button>
            <button class="glass-button session-btn" @click=${this._cancelNew}>cancel</button>
          ` : html`
            <button class="glass-button session-btn" @click=${this._newPainting}>new painting</button>
          `}
        </div>
      `;
    }

    return nothing;
  }

}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-mood-selector': MoodSelector;
  }
}
