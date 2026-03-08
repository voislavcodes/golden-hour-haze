import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';
import { pushHistory } from '../state/history.js';

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
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(232, 168, 64, 0.4);
        border: 1px solid rgba(232, 168, 64, 0.6);
        transform: translate(-50%, -50%);
        pointer-events: none;
        transition: opacity 0.2s;
      }
    `,
  ];

  @state() private _points: Array<{ x: number; y: number }> = [];
  @state() private _isActive: boolean = false;

  private _dragging = false;
  private _dragIndex = -1;
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
    pushHistory();
    this._dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    // Find nearest existing point to drag, or add new one
    const depth = sceneStore.get().depth;
    let nearest = -1;
    let nearestDist = 0.05; // threshold to grab existing point
    for (let i = 0; i < depth.controlCount; i++) {
      const dx = depth.controlPoints[i * 2] - nx;
      const dy = depth.controlPoints[i * 2 + 1] - ny;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }

    if (nearest >= 0) {
      // Drag existing point
      this._dragIndex = nearest;
      this._updatePoint(nearest, nx, ny);
    } else {
      // Add new point
      this._dragIndex = depth.controlCount;
      this._addPoint(nx, ny);
    }
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging || !this._isActive || this._dragIndex < 0) return;
    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    this._updatePoint(this._dragIndex, nx, ny);
  }

  private _onPointerUp() {
    this._dragging = false;
    this._dragIndex = -1;
  }

  private _addPoint(nx: number, ny: number) {
    sceneStore.update((s) => {
      const cp = new Float32Array(s.depth.controlPoints);
      const count = Math.min(s.depth.controlCount + 1, 16);
      const idx = (count - 1) * 2;
      cp[idx] = nx;
      cp[idx + 1] = ny;
      return {
        depth: { ...s.depth, controlPoints: cp, controlCount: count },
      };
    });
  }

  private _updatePoint(index: number, nx: number, ny: number) {
    sceneStore.update((s) => {
      const cp = new Float32Array(s.depth.controlPoints);
      cp[index * 2] = nx;
      cp[index * 2 + 1] = ny;
      return {
        depth: { ...s.depth, controlPoints: cp },
      };
    });
  }

  render() {
    // Only show points when depth tool is active
    if (!this._isActive) {
      return html`<div style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerUp}
      ></div>`;
    }

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
