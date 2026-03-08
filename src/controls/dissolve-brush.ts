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
        cursor: pointer;
      }

      .stroke-preview {
        position: absolute;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          rgba(255, 200, 120, 0.3),
          transparent
        );
        pointer-events: none;
        transform: translate(-50%, -50%);
      }
    `,
  ];

  @state() private _isActive: boolean = false;
  @state() private _recentStrokes: BrushStroke[] = [];

  private _painting = false;
  private _strokes: BrushStroke[] = [];
  private _unsubTool?: () => void;

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
        }
      }
    );
    if (this._isActive) this.classList.add('active');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this._isActive) return;
    this._painting = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this._recordStroke(e);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._painting || !this._isActive) return;
    this._recordStroke(e);
  }

  private _onPointerUp(_e: PointerEvent) {
    this._painting = false;
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

    // Keep recent strokes for visual feedback (last 30)
    this._recentStrokes = this._strokes.slice(-30);

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
    this._recentStrokes = [];
  }

  render() {
    return html`
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerUp}
      >
        ${this._recentStrokes.map(
          (s) => html`
            <div
              class="stroke-preview"
              style="
                left: ${s.x * 100}%;
                top: ${s.y * 100}%;
                width: ${s.radius * 200}%;
                height: ${s.radius * 200}%;
                opacity: ${s.pressure * 0.6};
              "
            ></div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-dissolve-brush': DissolveBrush;
  }
}
