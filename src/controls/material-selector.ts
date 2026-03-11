// Material selector — 4 material cards + tone/grain sliders
import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore, type MaterialType } from '../state/scene-state.js';
import { MATERIALS, getMaterial } from '../surface/materials.js';

const MATERIAL_TYPES: MaterialType[] = ['board', 'canvas', 'paper', 'gesso'];

function rgbToCSS(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

@customElement('ghz-material-selector')
export class MaterialSelector extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
      }

      .cards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .card {
        width: auto;
        padding: 10px;
        cursor: pointer;
        transition: border-color 0.2s, box-shadow 0.2s;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }

      .card:hover {
        border-color: rgba(255, 200, 120, 0.4);
      }

      .card.selected {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 16px rgba(232, 168, 64, 0.25);
      }

      .swatch {
        width: 100%;
        height: 24px;
        border-radius: 4px;
      }

      .card-name {
        font-size: 11px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: var(--ghz-text);
      }

      .sliders {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 100%;
      }

      .slider-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .slider-label {
        font-size: 10px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: var(--ghz-text-dim);
        width: 44px;
        text-align: right;
      }

      .slider-track {
        flex: 1;
        height: 4px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        position: relative;
        cursor: pointer;
        touch-action: none;
      }

      .slider-fill {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(to right, rgba(232, 168, 64, 0.2), rgba(232, 168, 64, 0.6));
      }

      .slider-thumb {
        position: absolute;
        top: 50%;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: rgba(232, 168, 64, 0.9);
        border: 2px solid rgba(0, 0, 0, 0.3);
        box-shadow: 0 0 6px rgba(232, 168, 64, 0.4);
        transform: translate(-50%, -50%);
        cursor: grab;
      }

      .slider-thumb:active {
        cursor: grabbing;
      }

      .shuffle-row {
        display: flex;
        justify-content: flex-end;
        width: 100%;
      }

      .shuffle-btn {
        padding: 6px 14px;
        font-size: 10px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .ground-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .ground-label {
        font-size: 10px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: var(--ghz-text-dim);
      }

      .ground-btn {
        padding: 6px 14px;
        font-size: 10px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .ground-btn.disabled {
        opacity: 0.35;
        cursor: not-allowed;
        pointer-events: none;
      }
    `,
  ];

  @state() private _material: MaterialType = 'board';
  @state() private _tone = 0.3;
  @state() private _grainScale = 0.5;
  @state() private _grainSize = 0.5;
  private _dragging: 'tone' | 'rough' | 'size' | null = null;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    const s = sceneStore.get().surface;
    this._material = s.material;
    this._tone = s.tone;
    this._grainScale = s.grainScale;
    this._grainSize = s.grainSize;
    this._unsubscribe = sceneStore.select(
      (s) => s.surface,
      (surface) => {
        this._material = surface.material;
        this._tone = surface.tone;
        this._grainScale = surface.grainScale;
        this._grainSize = surface.grainSize;
      },
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _selectMaterial(type: MaterialType) {
    const mat = getMaterial(type);
    sceneStore.update((s) => ({
      surface: {
        ...s.surface,
        material: type,
        absorption: mat.absorption,
        drySpeed: mat.drySpeed,
      },
    }));
  }

  private _onSliderDown(which: 'tone' | 'rough' | 'size', e: PointerEvent) {
    this._dragging = which;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this._updateSlider(which, e);
  }

  private _onSliderMove(which: 'tone' | 'rough' | 'size', e: PointerEvent) {
    if (this._dragging !== which) return;
    this._updateSlider(which, e);
  }

  private _onSliderUp() {
    this._dragging = null;
  }

  private _updateSlider(which: 'tone' | 'rough' | 'size', e: PointerEvent) {
    const track = (e.currentTarget as HTMLElement);
    const rect = track.getBoundingClientRect();
    const val = this.clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (which === 'tone') {
      this._tone = val;
      sceneStore.update((s) => ({ surface: { ...s.surface, tone: val } }));
    } else if (which === 'rough') {
      this._grainScale = val;
      sceneStore.update((s) => ({ surface: { ...s.surface, grainScale: val } }));
    } else {
      this._grainSize = val;
      sceneStore.update((s) => ({ surface: { ...s.surface, grainSize: val } }));
    }
  }

  private _shuffle() {
    const seed = Math.random() * 1000;
    sceneStore.update((s) => ({ surface: { ...s.surface, seed } }));
  }

  private _swatchGradient(type: MaterialType): string {
    const m = MATERIALS[type];
    const light = rgbToCSS(m.colorLight[0], m.colorLight[1], m.colorLight[2]);
    const dark = rgbToCSS(m.colorDark[0], m.colorDark[1], m.colorDark[2]);
    return `linear-gradient(to right, ${light}, ${dark})`;
  }

  render() {
    return html`
      <div class="cards">
        ${MATERIAL_TYPES.map(type => html`
          <div class="card glass ${this._material === type ? 'selected' : ''}"
               @click=${() => this._selectMaterial(type)}>
            <div class="swatch" style="background: ${this._swatchGradient(type)}"></div>
            <span class="card-name">${type}</span>
          </div>
        `)}
      </div>

      <div class="sliders">
        <div class="slider-row">
          <span class="slider-label">tone</span>
          <div class="slider-track"
               @pointerdown=${(e: PointerEvent) => this._onSliderDown('tone', e)}
               @pointermove=${(e: PointerEvent) => this._onSliderMove('tone', e)}
               @pointerup=${this._onSliderUp}
               @pointerleave=${this._onSliderUp}>
            <div class="slider-fill" style="width: ${this._tone * 100}%"></div>
            <div class="slider-thumb" style="left: ${this._tone * 100}%"></div>
          </div>
        </div>
        <div class="slider-row">
          <span class="slider-label">rough</span>
          <div class="slider-track"
               @pointerdown=${(e: PointerEvent) => this._onSliderDown('rough', e)}
               @pointermove=${(e: PointerEvent) => this._onSliderMove('rough', e)}
               @pointerup=${this._onSliderUp}
               @pointerleave=${this._onSliderUp}>
            <div class="slider-fill" style="width: ${this._grainScale * 100}%"></div>
            <div class="slider-thumb" style="left: ${this._grainScale * 100}%"></div>
          </div>
        </div>
        <div class="slider-row">
          <span class="slider-label">size</span>
          <div class="slider-track"
               @pointerdown=${(e: PointerEvent) => this._onSliderDown('size', e)}
               @pointermove=${(e: PointerEvent) => this._onSliderMove('size', e)}
               @pointerup=${this._onSliderUp}
               @pointerleave=${this._onSliderUp}>
            <div class="slider-fill" style="width: ${this._grainSize * 100}%"></div>
            <div class="slider-thumb" style="left: ${this._grainSize * 100}%"></div>
          </div>
        </div>
      </div>

      <div class="shuffle-row">
        <button class="glass-button shuffle-btn" @click=${this._shuffle}>shuffle</button>
      </div>

      <div class="ground-row">
        <span class="ground-label">ground:</span>
        <button class="glass-button ground-btn active">fresh</button>
        <button class="glass-button ground-btn disabled">painted (coming soon)</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-material-selector': MaterialSelector;
  }
}
