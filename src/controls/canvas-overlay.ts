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

  private _onPointerMove(e: PointerEvent) {
    uiStore.set({
      mouseX: e.clientX,
      mouseY: e.clientY,
      pressure: e.pressure,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      pointerType: e.pointerType,
    });
  }

  private _onPointerDown(e: PointerEvent) {
    uiStore.set({ mouseDown: true, pressure: e.pressure });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerUp(_e: PointerEvent) {
    uiStore.set({ mouseDown: false, pressure: 0 });
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
