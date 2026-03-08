import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore, type Tool } from '../state/ui-state.js';

const TOOL_CURSORS: Record<Tool, string> = {
  select:   'default',
  form:     'crosshair',
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
    `,
  ];

  @state()
  private _cursor: string = 'crosshair';

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._cursor = TOOL_CURSORS[uiStore.get().activeTool];
    this._unsubscribe = uiStore.select(
      (s) => s.activeTool,
      (tool) => { this._cursor = TOOL_CURSORS[tool]; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
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

  render() {
    return html`
      <div
        class="overlay"
        style="cursor: ${this._cursor}"
        @pointermove=${this._onPointerMove}
        @pointerdown=${this._onPointerDown}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerUp}
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-canvas-overlay': CanvasOverlay;
  }
}
