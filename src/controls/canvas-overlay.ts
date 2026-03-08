import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore, type Tool } from '../state/ui-state.js';

const BRUSH_TOOLS = new Set<Tool>(['cloud', 'form']);

const TOOL_CURSORS: Record<Tool, string> = {
  select:   'default',
  cloud:    'none',
  form:     'none',
  light:    'cell',
  dissolve: 'pointer',
  drift:    'grab',
  palette:  'copy',
  depth:    'ns-resize',
  anchor:   'crosshair',
};

@customElement('ghz-canvas-overlay')
export class CanvasOverlay extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 10;
        pointer-events: auto;
      }

      .overlay {
        width: 100%;
        height: 100%;
      }

      .brush-cursor {
        position: fixed;
        border-radius: 50%;
        border: 1.5px solid rgba(255, 255, 255, 0.55);
        pointer-events: none;
        transform: translate(-50%, -50%);
        z-index: 11;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2);
      }
    `,
  ];

  @state()
  private _cursor: string = 'none';

  @state()
  private _showBrushCircle = true;

  @state()
  private _mx = 0;

  @state()
  private _my = 0;

  @state()
  private _brushDiameter = 0;

  private _unsubscribe?: () => void;
  private _activeTool: Tool = 'cloud';

  connectedCallback() {
    super.connectedCallback();
    this._activeTool = uiStore.get().activeTool;
    this._cursor = TOOL_CURSORS[this._activeTool];
    this._showBrushCircle = BRUSH_TOOLS.has(this._activeTool);
    this._updateBrushDiameter(uiStore.get().brushSize);
    this._unsubscribe = uiStore.subscribe((s) => {
      if (s.activeTool !== this._activeTool) {
        this._activeTool = s.activeTool;
        this._cursor = TOOL_CURSORS[this._activeTool];
        this._showBrushCircle = BRUSH_TOOLS.has(this._activeTool);
      }
      this._updateBrushDiameter(s.brushSize);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _updateBrushDiameter(brushSize: number) {
    // brushSize is radius in normalized-Y space (0-1 of height)
    // At default pressure 0.5, effective size = brushSize * (0.5 + 0.5) = brushSize
    this._brushDiameter = brushSize * 2 * window.innerHeight;
  }

  private _normalizeCoords(e: PointerEvent): { x: number; y: number } {
    return {
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    };
  }

  // Trackpads on Mac report pressure 0; default to 0.5 for usable form sizes
  private _normalizePressure(e: PointerEvent): number {
    return e.pressure > 0 ? e.pressure : 0.5;
  }

  private _onPointerMove(e: PointerEvent) {
    const { x, y } = this._normalizeCoords(e);
    this._mx = e.clientX;
    this._my = e.clientY;
    uiStore.set({
      mouseX: x,
      mouseY: y,
      pressure: this._normalizePressure(e),
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      pointerType: e.pointerType,
    });
  }

  private _onPointerDown(e: PointerEvent) {
    const { x, y } = this._normalizeCoords(e);
    this._mx = e.clientX;
    this._my = e.clientY;
    uiStore.set({
      mouseX: x,
      mouseY: y,
      mouseDown: true,
      pressure: this._normalizePressure(e),
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      pointerType: e.pointerType,
    });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerUp(e: PointerEvent) {
    const { x, y } = this._normalizeCoords(e);
    uiStore.set({
      mouseX: x,
      mouseY: y,
      mouseDown: false,
      pressure: 0,
    });
  }

  private _onLostCapture() {
    // Pointer capture released without pointerup (e.g. system gesture)
    if (uiStore.get().mouseDown) {
      uiStore.set({ mouseDown: false, pressure: 0 });
    }
  }

  render() {
    return html`
      ${this._showBrushCircle ? html`
        <div
          class="brush-cursor"
          style="left:${this._mx}px;top:${this._my}px;width:${this._brushDiameter}px;height:${this._brushDiameter}px"
        ></div>
      ` : ''}
      <div
        class="overlay"
        style="cursor: ${this._cursor}"
        @pointermove=${this._onPointerMove}
        @pointerdown=${this._onPointerDown}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerUp}
        @lostpointercapture=${this._onLostCapture}
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-canvas-overlay': CanvasOverlay;
  }
}
