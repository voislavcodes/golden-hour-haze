import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';
import type { AnchorPoint } from '../layers/layer-types.js';

@customElement('ghz-anchor-control')
export class AnchorControl extends BaseControl {
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

      .anchor-marker {
        position: absolute;
        width: 16px;
        height: 16px;
        transform: translate(-50%, -50%) rotate(45deg);
        border: 2px solid var(--ghz-accent);
        box-shadow: 0 0 12px rgba(232, 168, 64, 0.6);
        pointer-events: none;
      }
    `,
  ];

  @state() private _anchor: AnchorPoint | null = null;
  @state() private _isActive: boolean = false;

  private _unsubTool?: () => void;
  private _unsubScene?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._isActive = uiStore.get().activeTool === 'anchor';
    this._unsubTool = uiStore.select(
      (s) => s.activeTool,
      (tool) => {
        this._isActive = tool === 'anchor';
        if (this._isActive) {
          this.classList.add('active');
        } else {
          this.classList.remove('active');
        }
      }
    );

    this._anchor = sceneStore.get().anchor;
    this._unsubScene = sceneStore.select(
      (s) => s.anchor,
      (anchor) => { this._anchor = anchor; }
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

    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    sceneStore.set({
      anchor: {
        x: nx,
        y: ny,
        chromaBoost: 0.6,
        muteFalloff: 0.4,
      },
    });
  }

  render() {
    return html`
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onPointerDown}
      >
        ${this._anchor ? html`
          <div
            class="anchor-marker"
            style="left: ${this._anchor.x * 100}%; top: ${this._anchor.y * 100}%;"
          ></div>
        ` : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-anchor-control': AnchorControl;
  }
}
