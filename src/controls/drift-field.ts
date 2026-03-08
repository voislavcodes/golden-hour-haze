import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';

@customElement('ghz-drift-field')
export class DriftField extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 15;
        pointer-events: none;
      }

      :host(.active) {
        pointer-events: auto;
        cursor: grab;
      }

      :host(.active.dragging) {
        cursor: grabbing;
      }

      .arrow {
        position: absolute;
        top: 50%;
        left: 50%;
        transform-origin: center center;
        pointer-events: none;
      }

      .arrow-line {
        width: 2px;
        background: var(--ghz-accent);
        border-radius: 1px;
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        opacity: 0.6;
      }

      .arrow-head {
        width: 0;
        height: 0;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-bottom: 8px solid var(--ghz-accent);
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        opacity: 0.6;
      }

      .info {
        position: absolute;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
        color: var(--ghz-text-dim);
        white-space: nowrap;
        pointer-events: none;
      }
    `,
  ];

  @state() private _isActive: boolean = false;
  @state() private _driftX: number = 0;
  @state() private _driftY: number = 0;
  @state() private _isDragging: boolean = false;

  private _startX = 0;
  private _startY = 0;
  private _startDriftX = 0;
  private _startDriftY = 0;
  private _unsubTool?: () => void;
  private _unsubScene?: () => void;

  connectedCallback() {
    super.connectedCallback();

    this._isActive = uiStore.get().activeTool === 'drift';
    this._unsubTool = uiStore.select(
      (s) => s.activeTool,
      (tool) => {
        this._isActive = tool === 'drift';
        if (this._isActive) {
          this.classList.add('active');
        } else {
          this.classList.remove('active');
          this._isDragging = false;
        }
      }
    );

    const atmo = sceneStore.get().atmosphere;
    this._driftX = atmo.driftX;
    this._driftY = atmo.driftY;
    this._unsubScene = sceneStore.select(
      (s) => s.atmosphere,
      (atmo) => {
        this._driftX = atmo.driftX;
        this._driftY = atmo.driftY;
      }
    );

    if (this._isActive) this.classList.add('active');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    this._unsubScene?.();
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this._isActive) return;
    this._isDragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._startDriftX = this._driftX;
    this._startDriftY = this._driftY;
    this.classList.add('dragging');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._isDragging || !this._isActive) return;

    const dx = (e.clientX - this._startX) * 0.003;
    const dy = (e.clientY - this._startY) * 0.003;

    const newDriftX = this.clamp(this._startDriftX + dx, -1, 1);
    const newDriftY = this.clamp(this._startDriftY + dy, -1, 1);

    this._driftX = newDriftX;
    this._driftY = newDriftY;

    sceneStore.update((s) => ({
      atmosphere: { ...s.atmosphere, driftX: newDriftX, driftY: newDriftY },
    }));
  }

  private _onPointerUp(_e: PointerEvent) {
    this._isDragging = false;
    this.classList.remove('dragging');
  }

  private get _arrowLength(): number {
    return Math.sqrt(this._driftX ** 2 + this._driftY ** 2) * 100;
  }

  private get _arrowAngle(): number {
    return Math.atan2(this._driftY, this._driftX) * (180 / Math.PI) - 90;
  }

  render() {
    if (!this._isActive) return html``;

    const len = this._arrowLength;

    return html`
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerUp}
      >
        ${len > 2
          ? html`
              <div
                class="arrow"
                style="transform: translate(-50%, -50%) rotate(${this._arrowAngle}deg)"
              >
                <div class="arrow-head"></div>
                <div class="arrow-line" style="height: ${len}px"></div>
              </div>
            `
          : null}
        <div class="info">
          drift: ${this._driftX.toFixed(2)}, ${this._driftY.toFixed(2)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-drift-field': DriftField;
  }
}
