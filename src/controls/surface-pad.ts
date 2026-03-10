import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';

interface SurfacePreset {
  label: string;
  grainSize: number;
  directionality: number;
  mode: 'standard' | 'woodblock';
  absorption: number;
  drySpeed: number;
}

const PRESETS: Record<string, SurfacePreset> = {
  board:     { label: 'board',     grainSize: 0.3, directionality: 0.7, mode: 'standard',  absorption: 0.15, drySpeed: 1.0 },
  canvas:    { label: 'canvas',    grainSize: 0.7, directionality: 0.8, mode: 'standard',  absorption: 0.10, drySpeed: 0.9 },
  smooth:    { label: 'smooth',    grainSize: 0.1, directionality: 0.1, mode: 'standard',  absorption: 0.05, drySpeed: 0.7 },
  paper:     { label: 'paper',     grainSize: 0.5, directionality: 0.2, mode: 'standard',  absorption: 0.25, drySpeed: 1.4 },
  woodblock: { label: 'woodblock', grainSize: 0.4, directionality: 0.9, mode: 'woodblock', absorption: 0.20, drySpeed: 1.2 },
};

@customElement('ghz-surface-pad')
export class SurfacePad extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 80px;
        left: 20px;
        z-index: 100;
        pointer-events: auto;
      }

      .surface-container {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .pad-wrapper {
        position: relative;
      }

      .corner-label {
        position: absolute;
        font-size: 8px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.5px;
        cursor: pointer;
        transition: color var(--ghz-transition);
        white-space: nowrap;
      }

      .corner-label:hover {
        color: var(--ghz-accent);
      }

      .corner-label.active {
        color: var(--ghz-accent);
      }

      .corner-tl { top: -14px; left: 0; }
      .corner-tr { top: -14px; right: 0; }
      .corner-bl { bottom: -14px; left: 0; }
      .corner-br { bottom: -14px; right: 0; }

      .pad {
        width: 64px;
        height: 64px;
        border: 1px solid var(--ghz-glass-border);
        border-radius: 4px;
        background: var(--ghz-glass-bg);
        backdrop-filter: blur(var(--ghz-glass-blur));
        -webkit-backdrop-filter: blur(var(--ghz-glass-blur));
        cursor: crosshair;
        position: relative;
        touch-action: none;
        box-shadow: 0 4px 16px var(--ghz-shadow);
        transition: border-color var(--ghz-transition);
      }

      .pad:hover {
        border-color: rgba(255, 200, 120, 0.3);
      }

      .pad.dragging {
        cursor: grabbing;
        border-color: var(--ghz-accent);
      }

      .position-dot {
        position: absolute;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ghz-accent);
        box-shadow: 0 0 4px rgba(232, 168, 64, 0.8);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .label {
        text-align: center;
        font-size: 9px;
        color: var(--ghz-text-dim);
        margin-top: 20px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }

      .woodblock-label {
        font-size: 8px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.5px;
        cursor: pointer;
        transition: color var(--ghz-transition);
        margin-top: 18px;
        text-align: center;
      }

      .woodblock-label:hover {
        color: var(--ghz-accent);
      }

      .woodblock-label.active {
        color: var(--ghz-accent);
      }
    `,
  ];

  @state() private _grainSize = 0.3;
  @state() private _directionality = 0.7;
  @state() private _mode: 'standard' | 'woodblock' = 'standard';
  @state() private _dragging = false;
  // Visual-only position during drag (not committed to state until pointerup)
  @state() private _dragX = 0.3;
  @state() private _dragY = 0.7;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    const s = sceneStore.get();
    this._grainSize = s.surface.grainSize;
    this._directionality = s.surface.directionality;
    this._mode = s.surface.mode;
    this._dragX = this._grainSize;
    this._dragY = this._directionality;

    this._unsubscribe = sceneStore.select(
      (s) => s.surface,
      (surface) => {
        this._grainSize = surface.grainSize;
        this._directionality = surface.directionality;
        this._mode = surface.mode;
        if (!this._dragging) {
          this._dragX = surface.grainSize;
          this._dragY = surface.directionality;
        }
      }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _onPointerDown(e: PointerEvent) {
    this._dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this._updateDragFromEvent(e);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;
    this._updateDragFromEvent(e);
  }

  private _onPointerUp(_e: PointerEvent) {
    if (!this._dragging) return;
    this._dragging = false;
    // Commit to state on release — triggers LUT regen
    sceneStore.update((s) => ({
      surface: { ...s.surface, grainSize: this._dragX, directionality: this._dragY, mode: 'standard' },
    }));
  }

  private _updateDragFromEvent(e: PointerEvent) {
    const pad = this.shadowRoot!.querySelector('.pad') as HTMLElement;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    this._dragX = this.clamp((e.clientX - rect.left) / rect.width, 0, 1);
    this._dragY = this.clamp(1.0 - (e.clientY - rect.top) / rect.height, 0, 1);
  }

  private _onDblClick() {
    this._applyPreset('board');
  }

  private _applyPreset(name: string) {
    const p = PRESETS[name];
    if (!p) return;
    this._dragX = p.grainSize;
    this._dragY = p.directionality;
    sceneStore.update((s) => ({
      surface: { ...s.surface, grainSize: p.grainSize, directionality: p.directionality, mode: p.mode, absorption: p.absorption, drySpeed: p.drySpeed },
    }));
  }

  private _isPresetActive(name: string): boolean {
    const p = PRESETS[name];
    if (!p) return false;
    return Math.abs(this._grainSize - p.grainSize) < 0.05
        && Math.abs(this._directionality - p.directionality) < 0.05
        && this._mode === p.mode;
  }

  render() {
    const dotLeft = this._dragX * 100;
    const dotTop = (1 - this._dragY) * 100;

    return html`
      <div class="surface-container">
        <div class="pad-wrapper">
          <span class="corner-label corner-tl ${this._isPresetActive('board') ? 'active' : ''}"
                @click=${() => this._applyPreset('board')}>board</span>
          <span class="corner-label corner-tr ${this._isPresetActive('canvas') ? 'active' : ''}"
                @click=${() => this._applyPreset('canvas')}>canvas</span>
          <div
            class="pad ${this._dragging ? 'dragging' : ''}"
            @pointerdown=${this._onPointerDown}
            @pointermove=${this._onPointerMove}
            @pointerup=${this._onPointerUp}
            @pointerleave=${this._onPointerUp}
            @dblclick=${this._onDblClick}
          >
            <div
              class="position-dot"
              style="left: ${dotLeft}%; top: ${dotTop}%"
            ></div>
          </div>
          <span class="corner-label corner-bl ${this._isPresetActive('smooth') ? 'active' : ''}"
                @click=${() => this._applyPreset('smooth')}>smooth</span>
          <span class="corner-label corner-br ${this._isPresetActive('paper') ? 'active' : ''}"
                @click=${() => this._applyPreset('paper')}>paper</span>
        </div>
        <span class="woodblock-label ${this._isPresetActive('woodblock') ? 'active' : ''}"
              @click=${() => this._applyPreset('woodblock')}>woodblock</span>
        <div class="label">surface</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-surface-pad': SurfacePad;
  }
}
