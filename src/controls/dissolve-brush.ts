import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore } from '../state/ui-state.js';

export interface BrushStroke {
  x: number;      // normalized 0-1
  y: number;
  pressure: number;
  radius: number;
  timestamp: number;
}

@customElement('ghz-dissolve-brush')
export class DissolveBrush extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 16;
        pointer-events: none;
      }

      :host(.active) {
        pointer-events: auto;
        cursor: none;
      }

      .brush-cursor {
        position: fixed;
        border-radius: 50%;
        border: 1.5px solid rgba(255, 255, 255, 0.55);
        pointer-events: none;
        transform: translate(-50%, -50%);
        z-index: 17;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2);
      }

      .strength-hud {
        position: absolute;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        font: 500 11px/1 'SF Mono', 'Fira Code', monospace;
        color: rgba(255, 200, 120, 0.7);
        letter-spacing: 0.08em;
        pointer-events: none;
        user-select: none;
        text-shadow: 0 1px 4px rgba(0,0,0,0.5);
      }
    `,
  ];

  @state() private _isActive: boolean = false;
  @state() private _strength: number = 0.5;
  @state() private _cx = 0;
  @state() private _cy = 0;
  @state() private _brushDiameter = 0;

  private _painting = false;
  private _strokes: BrushStroke[] = [];
  private _unsubTool?: () => void;
  private _unsubStrength?: () => void;
  private _unsubBrushSize?: () => void;

  /** Access all recorded brush strokes */
  get strokes(): ReadonlyArray<BrushStroke> {
    return this._strokes;
  }

  connectedCallback() {
    super.connectedCallback();
    this._isActive = uiStore.get().activeTool === 'dissolve';
    this._unsubTool = uiStore.select(
      (s) => s.activeTool,
      (tool) => {
        this._isActive = tool === 'dissolve';
        if (this._isActive) {
          this.classList.add('active');
        } else {
          this.classList.remove('active');
          this._painting = false;
          this.clearStrokes();
        }
      }
    );
    if (this._isActive) this.classList.add('active');

    this._strength = uiStore.get().dissolveStrength;
    this._unsubStrength = uiStore.select(
      (s) => s.dissolveStrength,
      (v) => { this._strength = v; }
    );

    this._brushDiameter = uiStore.get().brushSize * 2 * window.innerHeight;
    this._unsubBrushSize = uiStore.select(
      (s) => s.brushSize,
      (size) => { this._brushDiameter = size * 2 * window.innerHeight; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    this._unsubStrength?.();
    this._unsubBrushSize?.();
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this._isActive) return;
    this._painting = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this._forwardPointer(e, true);
    this._recordStroke(e);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._isActive) return;
    this._forwardPointer(e, this._painting);
    if (!this._painting) return;
    this._recordStroke(e);
  }

  /** Forward pointer state to uiStore and update local brush cursor */
  private _forwardPointer(e: PointerEvent, down: boolean) {
    this._cx = e.clientX;
    this._cy = e.clientY;
    this._brushDiameter = uiStore.get().brushSize * 2 * window.innerHeight;
    uiStore.set({
      mouseX: e.clientX / window.innerWidth,
      mouseY: e.clientY / window.innerHeight,
      pressure: e.pressure > 0 ? e.pressure : 0.5,
      ...(down ? { mouseDown: true } : {}),
    });
  }

  private _onPointerUp(_e: PointerEvent) {
    this._painting = false;
    uiStore.set({ mouseDown: false, pressure: 0 });
    this.dispatchEvent(
      new CustomEvent('dissolve-stroke-end', {
        detail: { strokes: [...this._strokes] },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _recordStroke(e: PointerEvent) {
    const rect = this.getBoundingClientRect();
    const stroke: BrushStroke = {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
      pressure: e.pressure || 0.5,
      radius: uiStore.get().brushSize * (0.5 + (e.pressure || 0.5)),
      timestamp: performance.now(),
    };

    this._strokes.push(stroke);

    this.dispatchEvent(
      new CustomEvent('dissolve-stroke', {
        detail: stroke,
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Clear all recorded strokes */
  clearStrokes() {
    this._strokes = [];
  }

  render() {
    return html`
      ${this._isActive ? html`
        <div
          class="brush-cursor"
          style="left:${this._cx}px;top:${this._cy}px;width:${this._brushDiameter}px;height:${this._brushDiameter}px"
        ></div>
      ` : ''}
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerUp}
      >
        ${this._isActive ? html`<div class="strength-hud">DSLV ${this._strength.toFixed(2)}</div>` : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-dissolve-brush': DissolveBrush;
  }
}
