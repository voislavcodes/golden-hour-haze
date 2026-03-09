import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore, pointerQueue, type Tool } from '../state/ui-state.js';

const BRUSH_TOOLS = new Set<Tool>(['form', 'scrape', 'wipe']);

const TOOL_CURSORS: Record<Tool, string> = {
  select:   'default',
  form:     'none',
  light:    'cell',
  scrape:   'none',
  wipe:     'none',
  drift:    'grab',
  palette:  'copy',
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
        touch-action: none;
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

      .blade-cursor {
        position: fixed;
        height: 2px;
        border-radius: 0;
        border: 1px solid rgba(255, 255, 255, 0.55);
        pointer-events: none;
        z-index: 11;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2);
        background: rgba(255, 255, 255, 0.15);
      }

      .horizon-guide {
        position: absolute;
        left: 0;
        right: 0;
        height: 0;
        border-top: 1px dashed rgba(255, 255, 255, 0.3);
        pointer-events: none;
        transition: opacity 0.5s;
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

  @state()
  private _horizonGuideY: number = 0;

  @state()
  private _horizonGuideVisible: boolean = false;

  private _horizonFadeTimer?: number;
  private _unsubscribe?: () => void;
  private _activeTool: Tool = 'form';
  private _scrapeDir = { x: 1, y: 0 };
  private _prevPointerPos: { x: number; y: number } | null = null;

  private _horizonHandler = ((e: CustomEvent) => {
    const { y, active } = e.detail as { y: number; active: boolean };
    if (y < 0) { this._horizonGuideVisible = false; return; }
    this._horizonGuideY = y;
    if (active) {
      clearTimeout(this._horizonFadeTimer);
      this._horizonGuideVisible = true;
    } else {
      this._horizonFadeTimer = window.setTimeout(() => {
        this._horizonGuideVisible = false;
      }, 500);
    }
  }) as EventListener;

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
    document.addEventListener('horizon-drag', this._horizonHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    document.removeEventListener('horizon-drag', this._horizonHandler);
    clearTimeout(this._horizonFadeTimer);
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
    // Queue all coalesced positions for the brush engine
    const coalesced = e.getCoalescedEvents?.() ?? [e];
    for (const ce of coalesced) {
      pointerQueue.push({
        x: ce.clientX / window.innerWidth,
        y: ce.clientY / window.innerHeight,
      });
    }

    const last = coalesced[coalesced.length - 1] ?? e;
    this._mx = last.clientX;
    this._my = last.clientY;

    // Track scrape direction from pointer movement
    if (this._activeTool === 'scrape') {
      const px = last.clientX;
      const py = last.clientY;
      if (this._prevPointerPos) {
        const dx = px - this._prevPointerPos.x;
        const dy = py - this._prevPointerPos.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 2) {
          const nx = dx / len;
          const ny = dy / len;
          this._scrapeDir.x = this._scrapeDir.x * 0.7 + nx * 0.3;
          this._scrapeDir.y = this._scrapeDir.y * 0.7 + ny * 0.3;
          const sLen = Math.sqrt(this._scrapeDir.x ** 2 + this._scrapeDir.y ** 2);
          if (sLen > 0.001) {
            this._scrapeDir.x /= sLen;
            this._scrapeDir.y /= sLen;
          }
          this.requestUpdate();
        }
      }
      this._prevPointerPos = { x: px, y: py };
    }

    const { x, y } = this._normalizeCoords(last);
    uiStore.set({
      mouseX: x,
      mouseY: y,
      pressure: this._normalizePressure(last),
      tiltX: last.tiltX,
      tiltY: last.tiltY,
      pointerType: last.pointerType,
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
      ${this._showBrushCircle && this._activeTool !== 'scrape' ? html`
        <div
          class="brush-cursor"
          style="left:${this._mx}px;top:${this._my}px;width:${this._brushDiameter}px;height:${this._brushDiameter}px"
        ></div>
      ` : ''}
      ${this._activeTool === 'scrape' ? html`
        <div
          class="blade-cursor"
          style="left:${this._mx}px;top:${this._my}px;width:${this._brushDiameter}px;transform:translate(-50%,-50%) rotate(${Math.atan2(this._scrapeDir.x, -this._scrapeDir.y) * (180 / Math.PI)}deg)"
        ></div>
      ` : ''}
      ${this._horizonGuideVisible ? html`
        <div
          class="horizon-guide"
          style="top: ${this._horizonGuideY * 100}%; opacity: ${this._horizonGuideVisible ? 1 : 0}"
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
