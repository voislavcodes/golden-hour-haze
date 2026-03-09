import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore, sunElevationFromAngle } from '../state/scene-state.js';

@customElement('ghz-time-dial')
export class TimeDial extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 80px;
        right: 20px;
        z-index: 100;
        pointer-events: auto;
      }

      .dial-container {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .dial {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        position: relative;
        cursor: grab;
        touch-action: none;
      }

      .dial.dragging {
        cursor: grabbing;
      }

      .dial-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid var(--ghz-glass-border);
        transition: border-color 0.2s;
        background: conic-gradient(
          from 0deg,
          rgba(60, 50, 90, 0.25) 0deg,
          rgba(100, 140, 200, 0.2) 45deg,
          rgba(232, 168, 64, 0.25) 90deg,
          rgba(200, 190, 170, 0.12) 180deg,
          rgba(232, 168, 64, 0.25) 270deg,
          rgba(100, 140, 200, 0.2) 315deg,
          rgba(60, 50, 90, 0.25) 360deg
        );
        backdrop-filter: blur(var(--ghz-glass-blur));
        -webkit-backdrop-filter: blur(var(--ghz-glass-blur));
      }

      .dial-indicator {
        position: absolute;
        width: 3px;
        height: 20px;
        background: var(--ghz-accent);
        border-radius: 2px;
        top: 4px;
        left: 50%;
        transform-origin: bottom center;
        transform: translateX(-50%);
        box-shadow: 0 0 6px rgba(232, 168, 64, 0.5);
      }

      .dial-center {
        position: absolute;
        width: 8px;
        height: 8px;
        background: var(--ghz-accent-dim);
        border-radius: 50%;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }

      .label {
        text-align: center;
        font-size: 9px;
        color: var(--ghz-text-dim);
        margin-top: 6px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }

      .time-value {
        text-align: center;
        font-size: 10px;
        color: var(--ghz-accent);
        margin-top: 2px;
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  @state() private _angle: number = 1.28;
  @state() private _azimuth: number = 0.5;
  @state() private _dragging: boolean = false;
  @state() private _shiftHeld: boolean = false;

  private _unsubscribe?: () => void;
  private _unsubAzimuth?: () => void;
  private _angleLUT: Float32Array = new Float32Array(256);

  private _buildAngleLUT() {
    // Non-linear mapping: golden hour (~0.75 rad) and blue hour (~5.5 rad) get 10x resolution
    const N = 256;
    const weights = new Float32Array(N);
    let total = 0;

    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      // Gaussian weight centered on golden hour and blue hour
      const gd = angle - 0.75;
      const bd = angle - 5.5;
      const w = 1.0 + 15.0 * (Math.exp(-gd * gd * 3) + Math.exp(-bd * bd * 3));
      weights[i] = w;
      total += w;
    }

    // Build cumulative distribution → angle LUT
    let cum = 0;
    for (let i = 0; i < N; i++) {
      cum += weights[i] / total;
      this._angleLUT[i] = cum * Math.PI * 2;
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this._buildAngleLUT();
    const s = sceneStore.get();
    this._angle = s.sunAngle;
    this._azimuth = s.sunAzimuth;
    // Initialize _lutT from angle (reverse LUT lookup)
    const idx = this._angleLUT.findIndex((a) => a >= this._angle);
    this._lutT = idx >= 0 ? idx / 256 : 0;
    this._unsubscribe = sceneStore.select(
      (s) => s.sunAngle,
      (angle) => { this._angle = angle; }
    );
    this._unsubAzimuth = sceneStore.select(
      (s) => s.sunAzimuth,
      (az) => { this._azimuth = az; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubAzimuth?.();
  }

  private _lastClientX = 0;
  private _lastClientY = 0;
  /** LUT position (0-1) for smooth delta-based dragging */
  private _lutT = 0;

  private _onPointerDown(e: PointerEvent) {
    this._dragging = true;
    this._shiftHeld = e.shiftKey;
    this._lastClientX = e.clientX;
    this._lastClientY = e.clientY;
    // Find current LUT position from angle (reverse lookup)
    this._lutT = this._angleLUT.findIndex((a) => a >= this._angle) / 256;
    if (this._lutT < 0) this._lutT = 0;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;

    const dx = e.clientX - this._lastClientX;
    const dy = e.clientY - this._lastClientY;
    this._lastClientX = e.clientX;
    this._lastClientY = e.clientY;

    // Shift+drag: horizontal azimuth control
    if (e.shiftKey) {
      this._shiftHeld = true;
      const newAz = Math.max(0, Math.min(1, this._azimuth + dx * 0.003));
      this._azimuth = newAz;
      sceneStore.set({ sunAzimuth: newAz });
      return;
    }
    this._shiftHeld = false;

    // Vertical drag only: up = brighter (noon), down = darker (dusk)
    // ~300px drag = full sweep
    const delta = -dy * 0.0033;
    this._lutT = ((this._lutT + delta) % 1 + 1) % 1; // wrap 0-1
    const idx = Math.min(255, Math.floor(this._lutT * 256));
    const angle = this._angleLUT[idx];

    this._angle = angle;
    sceneStore.set({ sunAngle: angle, sunElevation: sunElevationFromAngle(angle) });
  }

  private _onPointerUp(_e: PointerEvent) {
    this._dragging = false;
    this._shiftHeld = false;
  }

  private get _timeLabel(): string {
    return this._lutT.toFixed(2);
  }

  /** Indicator rotation in degrees */
  private get _indicatorRotation(): number {
    return (this._angle * 180) / Math.PI;
  }

  render() {
    return html`
      <div class="dial-container">
        <div
          class="dial ${this._dragging ? 'dragging' : ''}"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointerleave=${this._onPointerUp}
        >
          <div class="dial-ring" style="border-color: ${this._shiftHeld ? 'rgba(100, 180, 255, 0.6)' : ''}"></div>
          <div
            class="dial-indicator"
            style="transform: translateX(-50%) rotate(${this._indicatorRotation}deg)"
          ></div>
          <div class="dial-center"></div>
        </div>
        <div class="label">time</div>
        <div class="time-value">${this._timeLabel}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-time-dial': TimeDial;
  }
}
