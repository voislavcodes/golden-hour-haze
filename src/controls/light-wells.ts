import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';
import type { LightDef } from '../layers/layer-types.js';

@customElement('ghz-light-wells')
export class LightWells extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 14;
        pointer-events: none;
      }

      :host(.active) {
        pointer-events: auto;
        cursor: cell;
      }

      .light {
        position: absolute;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        cursor: grab;
        pointer-events: auto;
        border: 1px solid rgba(255, 255, 255, 0.3);
        transition: box-shadow var(--ghz-transition);
      }

      .light:hover {
        box-shadow: 0 0 16px rgba(255, 220, 150, 0.5);
      }

      .light.dragging {
        cursor: grabbing;
        box-shadow: 0 0 20px rgba(255, 220, 150, 0.7);
      }
    `,
  ];

  @state() private _lights: LightDef[] = [];
  @state() private _isActive: boolean = false;
  @state() private _dragIndex: number = -1;

  private _unsubTool?: () => void;
  private _unsubScene?: () => void;

  connectedCallback() {
    super.connectedCallback();

    this._isActive = uiStore.get().activeTool === 'light';
    this._unsubTool = uiStore.select(
      (s) => s.activeTool,
      (tool) => {
        this._isActive = tool === 'light';
        if (this._isActive) {
          this.classList.add('active');
        } else {
          this.classList.remove('active');
        }
      }
    );

    this._lights = [...sceneStore.get().lights];
    this._unsubScene = sceneStore.select(
      (s) => s.lights,
      (lights) => { this._lights = [...lights]; }
    );

    if (this._isActive) this.classList.add('active');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    this._unsubScene?.();
  }

  private _onCanvasClick(e: PointerEvent) {
    if (!this._isActive) return;

    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    const newLight: LightDef = {
      x: nx,
      y: ny,
      depth: 0.5,
      intensity: 0.8,
      radius: 0.15,
      colorR: 1.0,
      colorG: 0.85,
      colorB: 0.6,
      scatter: 0.5,
    };

    sceneStore.update((s) => ({
      lights: [...s.lights, newLight],
    }));
  }

  private _onLightPointerDown(e: PointerEvent, index: number) {
    e.stopPropagation();
    this._dragIndex = index;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onLightPointerMove(e: PointerEvent) {
    if (this._dragIndex < 0) return;

    const rect = this.getBoundingClientRect();
    const nx = this.clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const ny = this.clamp((e.clientY - rect.top) / rect.height, 0, 1);

    sceneStore.update((s) => {
      const lights = [...s.lights];
      lights[this._dragIndex] = {
        ...lights[this._dragIndex],
        x: nx,
        y: ny,
      };
      return { lights };
    });
  }

  private _onLightPointerUp(_e: PointerEvent) {
    this._dragIndex = -1;
  }

  private _lightColor(light: LightDef): string {
    const r = Math.round(light.colorR * 255);
    const g = Math.round(light.colorG * 255);
    const b = Math.round(light.colorB * 255);
    return `rgba(${r}, ${g}, ${b}, ${light.intensity})`;
  }

  render() {
    return html`
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onCanvasClick}
      >
        ${this._lights.map(
          (light, i) => html`
            <div
              class="light ${this._dragIndex === i ? 'dragging' : ''}"
              style="
                left: ${light.x * 100}%;
                top: ${light.y * 100}%;
                background: radial-gradient(circle, ${this._lightColor(light)}, transparent);
                box-shadow: 0 0 ${light.radius * 80}px ${this._lightColor(light)};
              "
              @pointerdown=${(e: PointerEvent) => this._onLightPointerDown(e, i)}
              @pointermove=${this._onLightPointerMove}
              @pointerup=${this._onLightPointerUp}
            ></div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-light-wells': LightWells;
  }
}
