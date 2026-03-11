import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore, pointerQueue, type Tool } from '../state/ui-state.js';
import { getOilRemaining } from '../painting/palette.js';

const BRUSH_TOOLS = new Set<Tool>(['form', 'scrape', 'wipe']);

const TOOL_CURSORS: Record<Tool, string> = {
  select:   'default',
  form:     'none',
  scrape:   'none',
  wipe:     'none',
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
        transition: box-shadow 180ms ease;
      }
      .brush-cursor.oiled {
        box-shadow: 0 0 6px 2px rgba(255, 200, 50, var(--oil-opacity, 0.6));
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
        position: fixed;
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
  private _oilGlow = 0;

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
    this._updateBrushDiameter(uiStore.get().brushSize, uiStore.get().pressure || 0.5);
    this._unsubscribe = uiStore.subscribe((s) => {
      if (s.activeTool !== this._activeTool) {
        this._activeTool = s.activeTool;
        this._cursor = TOOL_CURSORS[this._activeTool];
        this._showBrushCircle = BRUSH_TOOLS.has(this._activeTool);
      }
      this._updateBrushDiameter(s.brushSize, s.pressure || 0.5);
    });
    document.addEventListener('horizon-drag', this._horizonHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    document.removeEventListener('horizon-drag', this._horizonHandler);
    clearTimeout(this._horizonFadeTimer);
  }

  private _getCanvasRect(): DOMRect {
    const canvas = document.getElementById('ghz');
    return canvas ? canvas.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  }

  private _updateBrushDiameter(brushSize: number, pressure: number = 0.5) {
    // brushSize is radius in normalized-Y space (0-1 of height)
    // Pressure modulates effective radius: 0.3 + 0.7 * pressure
    const effectiveRadius = brushSize * (0.3 + 0.7 * pressure);
    const rect = this._getCanvasRect();
    this._brushDiameter = effectiveRadius * 2 * rect.height;
    this._oilGlow = getOilRemaining();
  }

  private _normalizeCoords(e: PointerEvent): { x: number; y: number } {
    const rect = this._getCanvasRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }

  // Trackpads on Mac report pressure 0; default to 0.5 for usable form sizes
  private _normalizePressure(e: PointerEvent): number {
    return e.pressure > 0 ? e.pressure : 0.5;
  }

  private _onPointerMove(e: PointerEvent) {
    // Queue all coalesced positions for the brush engine
    const rect = this._getCanvasRect();
    const coalesced = e.getCoalescedEvents?.() ?? [e];
    for (const ce of coalesced) {
      pointerQueue.push({
        x: (ce.clientX - rect.left) / rect.width,
        y: (ce.clientY - rect.top) / rect.height,
        pressure: this._normalizePressure(ce),
        tiltX: ce.tiltX || 0,
        tiltY: ce.tiltY || 0,
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
    // Don't start strokes outside the canvas rect
    const rect = this._getCanvasRect();
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom) {
      return;
    }
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
          class="brush-cursor ${this._oilGlow > 0 ? 'oiled' : ''}"
          style="left:${this._mx}px;top:${this._my}px;width:${this._brushDiameter}px;height:${this._brushDiameter}px${this._oilGlow > 0 ? `;--oil-opacity:${this._oilGlow}` : ''}"
        ></div>
      ` : ''}
      ${this._activeTool === 'scrape' ? html`
        <div
          class="blade-cursor"
          style="left:${this._mx}px;top:${this._my}px;width:${this._brushDiameter}px;transform:translate(-50%,-50%) rotate(${Math.atan2(this._scrapeDir.x, -this._scrapeDir.y) * (180 / Math.PI)}deg)"
        ></div>
      ` : ''}
      ${this._horizonGuideVisible ? (() => {
        const rect = this._getCanvasRect();
        const top = rect.top + this._horizonGuideY * rect.height;
        return html`
          <div
            class="horizon-guide"
            style="left:${rect.left}px;width:${rect.width}px;top:${top}px;opacity:1"
          ></div>
        `;
      })() : ''}
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
