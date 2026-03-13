// Left side panel — unified prepare phase: mood + canvas size + surface
import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { type Mood, type KColor, DEFAULT_COMPLEMENT } from '../mood/moods.js';
import { sampleTonalColumn } from '../painting/palette.js';
import { getAllMoods, loadCustomMoods } from '../mood/custom-moods.js';
import { sessionStore, advancePhase, type SessionPhase } from '../session/session-state.js';
import { sceneStore } from '../state/scene-state.js';
import { deriveAtmosphere } from '../mood/derive-atmosphere.js';
import './mood-creator.js';
import type { MoodCreator } from './mood-creator.js';
import './material-selector.js';
import './artboard-selector.js';
import { getMaterial } from '../surface/materials.js';
import type { MaterialType } from '../state/scene-state.js';

function colorToCSS(c: KColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

@customElement('ghz-prepare-panel')
export class PreparePanel extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 340px;
        z-index: 1000;
        background: rgba(10, 8, 16, 0.88);
        backdrop-filter: blur(16px);
        border-right: 1px solid rgba(255, 200, 120, 0.12);
        overflow-y: auto;
        padding: 24px 20px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        pointer-events: auto;
      }

      :host([hidden]) {
        display: none;
      }

      .section-label {
        font-size: 10px;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        color: var(--ghz-text-dim);
      }

      .mood-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .card {
        padding: 10px;
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
        height: 24px;
        border-radius: 4px;
        margin-bottom: 6px;
      }

      .piles {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 2px;
        margin-bottom: 6px;
      }

      .pile-gradient {
        width: 100%;
        height: 24px;
        border-radius: 2px;
      }

      .card-name {
        font-size: 10px;
        text-align: center;
        letter-spacing: 0.5px;
        color: var(--ghz-text);
      }

      .card-desc {
        font-size: 8px;
        text-align: center;
        color: var(--ghz-text-dim);
        margin-top: 2px;
      }

      .create-btn {
        padding: 8px 16px;
        font-size: 10px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        align-self: center;
      }

      .test-btn {
        padding: 10px 28px;
        font-size: 12px;
        letter-spacing: 1px;
        text-transform: uppercase;
        align-self: center;
        margin-top: auto;
      }
    `,
  ];

  @state() private _phase: SessionPhase = 'prepare';
  @state() private _selectedMood = 0;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    loadCustomMoods();
    const s = sessionStore.get();
    this._phase = s.phase;
    this._selectedMood = s.moodIndex;
    this._unsubscribe = sessionStore.subscribe((state) => {
      this._phase = state.phase;
      this._selectedMood = state.moodIndex;
      this._updateVisibility();
    });
    this._updateVisibility();
    this.addEventListener('mood-created', () => {
      this.requestUpdate();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _updateVisibility() {
    const visible = this._phase === 'prepare';
    this.hidden = !visible;
    const container = document.getElementById('canvas-container');
    if (container) {
      container.style.paddingLeft = visible ? '340px' : '0';
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
      palette: {
        colors: mood.piles.map(p => ({ r: p.medium.r, g: p.medium.g, b: p.medium.b, a: 1 })),
        activeIndex: 0,
        activeTonalIndex: 2,
        tonalValues: [0.5, 0.5, 0.5, 0.5, 0.5],
      },
    }));
  }

  private _testCanvas() {
    advancePhase();
  }

  private _renderSkyGradient(mood: Mood): string {
    const complement = mood.complement ?? DEFAULT_COMPLEMENT;
    const warmLight = sampleTonalColumn(mood.piles[0].medium, 0.0, complement);
    const coolLight = sampleTonalColumn(mood.piles[3].medium, 0.0, complement);
    return `linear-gradient(to top, ${colorToCSS(warmLight)}, ${colorToCSS(coolLight)})`;
  }

  render() {
    if (this._phase !== 'prepare') return nothing;

    const moods = getAllMoods();
    return html`
      <span class="section-label">mood</span>
      <div class="mood-grid">
        ${moods.map((mood, i) => html`
          <div class="card glass ${this._selectedMood === i ? 'selected' : ''}"
               @click=${() => this._selectMood(i)}>
            <div class="sky-preview" style="background: ${this._renderSkyGradient(mood)}"></div>
            <div class="piles">
              ${mood.piles.map(pile => {
                const complement = mood.complement ?? DEFAULT_COMPLEMENT;
                const light = sampleTonalColumn(pile.medium, 0.0, complement);
                const dark = sampleTonalColumn(pile.medium, 1.0, complement);
                return html`
                  <div class="pile-gradient" style="background: linear-gradient(to bottom, ${colorToCSS(light)}, ${colorToCSS(pile.medium)} 50%, ${colorToCSS(dark)})"></div>
                `;
              })}
            </div>
            <div class="card-name">${mood.name}</div>
            <div class="card-desc">${mood.description}</div>
          </div>
        `)}
      </div>
      <button class="glass-button create-btn" @click=${this._openCreator}>create custom</button>

      <span class="section-label">canvas size</span>
      <ghz-artboard-selector></ghz-artboard-selector>

      <span class="section-label">surface</span>
      <ghz-material-selector></ghz-material-selector>

      <button class="glass-button test-btn" @click=${this._testCanvas}>test canvas</button>

      <ghz-mood-creator></ghz-mood-creator>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-prepare-panel': PreparePanel;
  }
}
