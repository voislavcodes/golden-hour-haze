import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { getReservoir } from '../painting/brush-engine.js';

@customElement('ghz-load-slider')
export class LoadSlider extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 80px;
        left: 170px;
        z-index: 100;
        pointer-events: auto;
      }

      .slider-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 10px 8px;
      }

      .slider-label {
        font-size: 9px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }

      .slider-track {
        width: 4px;
        height: 100px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        position: relative;
        cursor: pointer;
        touch-action: none;
      }

      .slider-fill {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        border-radius: 2px;
        background: linear-gradient(to top, var(--ghz-accent), rgba(232, 168, 64, 0.3));
      }

      .reservoir-fill {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        border-radius: 2px;
        background: rgba(232, 168, 64, 0.15);
        pointer-events: none;
      }

      .slider-thumb {
        position: absolute;
        left: 50%;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--ghz-accent);
        border: 2px solid rgba(0, 0, 0, 0.3);
        box-shadow: 0 0 6px rgba(232, 168, 64, 0.4);
        transform: translate(-50%, 50%);
        cursor: grab;
      }

      .slider-thumb:active {
        cursor: grabbing;
      }

      .slider-value {
        font-size: 10px;
        color: var(--ghz-accent);
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  @property({ type: Number })
  value: number = 0.5;

  @property({ type: Number })
  reservoirLevel: number = 0.5;

  private _unsub?: () => void;
  private _dragging = false;
  private _rafId = 0;

  connectedCallback() {
    super.connectedCallback();
    this.value = sceneStore.get().load;
    this._unsub = sceneStore.select(
      (s) => s.load,
      (v) => { this.value = v; }
    );
    this._pollReservoir();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    cancelAnimationFrame(this._rafId);
  }

  private _pollReservoir() {
    this.reservoirLevel = getReservoir();
    this._rafId = requestAnimationFrame(() => this._pollReservoir());
  }

  private _onPointerDown(e: PointerEvent) {
    this._dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this._updateFromEvent(e);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;
    this._updateFromEvent(e);
  }

  private _onPointerUp() {
    this._dragging = false;
  }

  private _updateFromEvent(e: PointerEvent) {
    const track = this.shadowRoot!.querySelector('.slider-track') as HTMLElement;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const y = 1.0 - this.clamp((e.clientY - rect.top) / rect.height, 0, 1);
    this.value = y;
    sceneStore.set({ load: y });
  }

  private _onDblClick() {
    this.value = 0.5;
    sceneStore.set({ load: 0.5 });
  }

  render() {
    const fillPercent = this.value * 100;
    const reservoirPercent = this.reservoirLevel * 100;
    return html`
      <div class="slider-container glass">
        <span class="slider-label">load</span>
        <div
          class="slider-track"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointerleave=${this._onPointerUp}
          @dblclick=${this._onDblClick}
        >
          <div class="reservoir-fill" style="height: ${reservoirPercent}%"></div>
          <div class="slider-fill" style="height: ${fillPercent}%"></div>
          <div class="slider-thumb" style="bottom: ${fillPercent}%"></div>
        </div>
        <span class="slider-value">${this.value.toFixed(2)}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-load-slider': LoadSlider;
  }
}
