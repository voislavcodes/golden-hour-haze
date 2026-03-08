import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';

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
        background: var(--ghz-glass-bg);
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

  @state() private _angle: number = 0.8;
  @state() private _dragging: boolean = false;

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._angle = sceneStore.get().sunAngle;
    this._unsubscribe = sceneStore.select(
      (s) => s.sunAngle,
      (angle) => { this._angle = angle; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _onPointerDown(e: PointerEvent) {
    this._dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;

    const dial = this.shadowRoot!.querySelector('.dial') as HTMLElement;
    const rect = dial.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // Compute angle from center to pointer
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    let angle = Math.atan2(dy, dx); // -PI to PI

    // Normalize to 0 - 2PI
    if (angle < 0) angle += Math.PI * 2;

    this._angle = angle;
    sceneStore.set({ sunAngle: angle });
  }

  private _onPointerUp(_e: PointerEvent) {
    this._dragging = false;
  }

  /** Convert radians to a human-readable time string (golden hour = ~6pm feel) */
  private get _timeLabel(): string {
    // Map 0-2PI to 0-24 hours for display
    const hours = (this._angle / (Math.PI * 2)) * 24;
    const h = Math.floor(hours) % 24;
    const m = Math.floor((hours - Math.floor(hours)) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
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
          <div class="dial-ring"></div>
          <div
            class="dial-indicator"
            style="transform: translateX(-50%) rotate(${this._indicatorRotation}deg)"
          ></div>
          <div class="dial-center"></div>
        </div>
        <div class="label">sun angle</div>
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
