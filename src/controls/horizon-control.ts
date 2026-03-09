import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';

@customElement('ghz-horizon')
export class HorizonControl extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 190px;
        right: 20px;
        z-index: 100;
        pointer-events: auto;
      }

      .horizon-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }

      .horizon-label {
        font-size: 9px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }

      .horizon-track {
        width: 64px;
        height: 60px;
        border-radius: 6px;
        position: relative;
        cursor: ns-resize;
        touch-action: none;
        overflow: hidden;
        border: 1px solid var(--ghz-glass-border);
        background: var(--ghz-glass-bg);
        backdrop-filter: blur(var(--ghz-glass-blur));
        -webkit-backdrop-filter: blur(var(--ghz-glass-blur));
      }

      .horizon-gradient {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .horizon-line {
        position: absolute;
        left: 4px;
        right: 4px;
        height: 0;
        border-top: 2px solid var(--ghz-accent);
        box-shadow: 0 0 6px rgba(232, 168, 64, 0.5);
        pointer-events: none;
      }

      .horizon-value {
        font-size: 10px;
        color: var(--ghz-accent);
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  @state() private _horizonY: number = 0.5;
  private _lastOnValue = 0.5;
  private _dragging = false;
  private _unsub?: () => void;

  private get _isOff(): boolean {
    return this._horizonY < 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this._horizonY = sceneStore.get().horizonY;
    if (!this._isOff) this._lastOnValue = this._horizonY;
    this._unsub = sceneStore.select(
      (s) => s.horizonY,
      (v) => {
        this._horizonY = v;
        if (v >= 0) this._lastOnValue = v;
      }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  private _onPointerDown(e: PointerEvent) {
    if (this._isOff) return;
    this._dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this._updateFromEvent(e);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;
    this._updateFromEvent(e);
  }

  private _onPointerUp() {
    if (this._dragging) {
      this._dragging = false;
      document.dispatchEvent(new CustomEvent('horizon-drag', {
        detail: { y: this._horizonY, active: false },
      }));
    }
  }

  private _onDblClick() {
    if (this._isOff) {
      // Restore last on position
      sceneStore.set({ horizonY: this._lastOnValue });
    } else {
      // Turn off
      this._lastOnValue = this._horizonY;
      sceneStore.set({ horizonY: -1.0 });
    }
  }

  private _updateFromEvent(e: PointerEvent) {
    const track = this.shadowRoot!.querySelector('.horizon-track') as HTMLElement;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const t = this.clamp((e.clientY - rect.top) / rect.height, 0, 1);
    const y = this.clamp(0.1 + t * 0.8, 0.1, 0.9);
    this._horizonY = y;
    sceneStore.set({ horizonY: y });
    document.dispatchEvent(new CustomEvent('horizon-drag', {
      detail: { y, active: true },
    }));
  }

  private get _gradient(): string {
    if (this._isOff) {
      return 'linear-gradient(to bottom, rgba(30, 30, 35, 0.5), rgba(30, 30, 35, 0.5))';
    }
    const hPos = (this._horizonY * 100);
    return `linear-gradient(to bottom,
      rgba(30, 50, 90, 0.6) 0%,
      rgba(200, 140, 60, 0.4) ${hPos}%,
      rgba(40, 30, 20, 0.5) 100%
    )`;
  }

  render() {
    const off = this._isOff;
    const lineTop = off ? 50 : this._horizonY * 100;
    return html`
      <div class="horizon-container">
        <span class="horizon-label">horizon</span>
        <div
          class="horizon-track"
          style="cursor: ${off ? 'pointer' : 'ns-resize'}; opacity: ${off ? 0.5 : 1}"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointerleave=${this._onPointerUp}
          @dblclick=${this._onDblClick}
        >
          <div class="horizon-gradient" style="background: ${this._gradient}"></div>
          ${off ? '' : html`<div class="horizon-line" style="top: ${lineTop}%"></div>`}
        </div>
        <span class="horizon-value">${off ? 'OFF' : this._horizonY.toFixed(2)}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-horizon': HorizonControl;
  }
}
