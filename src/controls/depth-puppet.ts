import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';

@customElement('ghz-depth-puppet')
export class DepthPuppet extends BaseControl {
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
        cursor: crosshair;
      }

      .point {
        position: absolute;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--ghz-accent-dim);
        border: 1px solid var(--ghz-accent);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .line {
        position: absolute;
        height: 1px;
        background: var(--ghz-glass-border);
        transform-origin: left center;
        pointer-events: none;
      }
    `,
  ];

  @state() private _points: Array<{ x: number; y: number }> = [];
  @state() private _isActive: boolean = false;

  private _dragging = false;
  private _unsubTool?: () => void;
  private _unsubScene?: () => void;

  connectedCallback() {
    super.connectedCallback();

    this._isActive = uiStore.get().activeTool === 'depth';
    this._unsubTool = uiStore.select(
      (s) => s.activeTool,
      (tool) => {
        this._isActive = tool === 'depth';
        if (this._isActive) {
          this.classList.add('active');
        } else {
          this.classList.remove('active');
        }
      }
    );

    // Read existing control points
    this._syncPointsFromStore();
    this._unsubScene = sceneStore.select(
      (s) => s.depth.controlCount,
      () => { this._syncPointsFromStore(); }
    );

    if (this._isActive) this.classList.add('active');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    this._unsubScene?.();
  }

  private _syncPointsFromStore() {
    const depth = sceneStore.get().depth;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < depth.controlCount; i++) {
      pts.push({
        x: depth.controlPoints[i * 2],
        y: depth.controlPoints[i * 2 + 1],
      });
    }
    this._points = pts;
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this._isActive) return;
    this._dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this._addPoint(e);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging || !this._isActive) return;
    this._addPoint(e);
  }

  private _onPointerUp(_e: PointerEvent) {
    this._dragging = false;
  }

  private _addPoint(e: PointerEvent) {
    const rect = this.getBoundingClientRect();
    // Normalize to 0-1
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    sceneStore.update((s) => {
      const cp = new Float32Array(s.depth.controlPoints);
      const count = Math.min(s.depth.controlCount + 1, 16);
      const idx = (count - 1) * 2;
      cp[idx] = nx;
      cp[idx + 1] = ny;
      return {
        depth: {
          ...s.depth,
          controlPoints: cp,
          controlCount: count,
        },
      };
    });
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
        ${this._points.map(
          (pt) => html`
            <div
              class="point"
              style="left: ${pt.x * 100}%; top: ${pt.y * 100}%;"
            ></div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-depth-puppet': DepthPuppet;
  }
}
