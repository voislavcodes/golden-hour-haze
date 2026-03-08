import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';

@customElement('ghz-atmosphere-orb')
export class AtmosphereOrb extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 100;
        pointer-events: auto;
      }

      .orb {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        cursor: grab;
        border: 1px solid var(--ghz-glass-border);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5),
                    inset 0 0 20px rgba(232, 168, 64, 0.15);
        transition: box-shadow var(--ghz-transition);
        touch-action: none;
      }

      .orb:hover {
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6),
                    inset 0 0 24px rgba(232, 168, 64, 0.25);
      }

      .orb.dragging {
        cursor: grabbing;
        box-shadow: 0 4px 28px rgba(0, 0, 0, 0.7),
                    inset 0 0 28px rgba(232, 168, 64, 0.35);
      }

      .label {
        text-align: center;
        font-size: 9px;
        color: var(--ghz-text-dim);
        margin-top: 6px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }
    `,
  ];

  @state() private _density: number = 0.5;
  @state() private _warmth: number = 0.3;
  @state() private _dragging: boolean = false;

  private _startX = 0;
  private _startY = 0;
  private _startDensity = 0;
  private _startWarmth = 0;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    const atmo = sceneStore.get().atmosphere;
    this._density = atmo.density;
    this._warmth = atmo.warmth;

    this._unsubscribe = sceneStore.select(
      (s) => s.atmosphere,
      (atmo) => {
        this._density = atmo.density;
        this._warmth = atmo.warmth;
      }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _onPointerDown(e: PointerEvent) {
    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._startDensity = this._density;
    this._startWarmth = this._warmth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;

    const dx = e.clientX - this._startX;
    const dy = e.clientY - this._startY;

    // Horizontal drag: density (0-1)
    const newDensity = this.clamp(this._startDensity + dx * 0.005, 0, 1);
    // Vertical drag: warmth (-1 to 1), up = warmer
    const newWarmth = this.clamp(this._startWarmth - dy * 0.008, -1, 1);

    this._density = newDensity;
    this._warmth = newWarmth;

    sceneStore.update((s) => ({
      atmosphere: { ...s.atmosphere, density: newDensity, warmth: newWarmth },
    }));
  }

  private _onPointerUp(_e: PointerEvent) {
    this._dragging = false;
  }

  private get _gradient(): string {
    const warmHue = 30 + this._warmth * 20; // 10-50
    const coolHue = 240 - this._warmth * 30; // 210-270
    const densityAlpha = 0.3 + this._density * 0.5;
    return `radial-gradient(
      circle at 35% 35%,
      hsla(${warmHue}, 80%, 65%, ${densityAlpha}),
      hsla(${coolHue}, 40%, 25%, ${densityAlpha * 0.8}),
      hsla(260, 30%, 12%, ${densityAlpha * 0.6})
    )`;
  }

  render() {
    return html`
      <div>
        <div
          class="orb ${this._dragging ? 'dragging' : ''}"
          style="background: ${this._gradient}"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointerleave=${this._onPointerUp}
        ></div>
        <div class="label">atmosphere</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-atmosphere-orb': AtmosphereOrb;
  }
}
