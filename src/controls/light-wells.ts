import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';
import type { LightDef } from '../layers/layer-types.js';
import { pushHistory } from '../state/history.js';

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

      .selection-ring {
        position: absolute;
        border: 1.5px solid rgba(255, 220, 150, 0.8);
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        transition: opacity 0.3s ease;
      }

      .selection-ring.faded {
        opacity: 0;
      }
    `,
  ];

  @state() private _lights: LightDef[] = [];
  @state() private _isActive: boolean = false;
  @state() private _dragIndex: number = -1;
  @state() private _selectedIndex: number = -1;
  @state() private _selectionFaded: boolean = false;

  private _unsubTool?: () => void;
  private _unsubScene?: () => void;
  private _gesturePointers: Map<number, { x: number; y: number }> = new Map();
  private _gestureBaseDist: number = 0;
  private _gestureBaseAngle: number = 0;
  private _gestureBaseCoreR: number = 0.02;
  private _gestureBaseBloomR: number = 0.08;
  private _gestureBaseRot: number = 0;
  private _gestureIndex: number = -1;
  private _fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private _rKeyHeld: boolean = false;
  private _placeDragStart: { x: number; y: number } | null = null;
  private _placedIndex: number = -1;

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
          this._selectedIndex = -1;
        }
      }
    );

    this._lights = [...sceneStore.get().lights];
    this._unsubScene = sceneStore.select(
      (s) => s.lights,
      (lights) => { this._lights = [...lights]; }
    );

    if (this._isActive) this.classList.add('active');

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    this._unsubScene?.();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
  }

  private _resetFadeTimer() {
    this._selectionFaded = false;
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => {
      this._selectionFaded = true;
    }, 2000);
  }

  private _onKeyDown(e: KeyboardEvent) {
    if (e.key === 'r' || e.key === 'R') this._rKeyHeld = true;
    if ((e.key === 'Backspace' || e.key === 'Delete') && this._selectedIndex >= 0 && this._isActive) {
      e.preventDefault();
      this._deleteLight(this._selectedIndex);
    }
  }

  private _onKeyUp(e: KeyboardEvent) {
    if (e.key === 'r' || e.key === 'R') this._rKeyHeld = false;
  }

  private _hitTest(nx: number, ny: number): number {
    let bestIndex = -1;
    let bestDist = Infinity;
    const minHitDist = 30 / Math.max(this.clientWidth, 1);
    for (let i = 0; i < this._lights.length; i++) {
      const l = this._lights[i];
      const dx = nx - l.x;
      const dy = ny - l.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = Math.max(l.coreRadius * 2, minHitDist);
      if (dist < hitRadius && dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private _deleteLight(index: number) {
    pushHistory();
    sceneStore.update((s) => ({
      lights: s.lights.filter((_, i) => i !== index),
    }));
    this._selectedIndex = -1;
  }

  private _onCanvasPointerDown(e: PointerEvent) {
    if (!this._isActive) return;

    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    const hitIdx = this._hitTest(nx, ny);

    if (hitIdx >= 0) {
      // Cmd+click on existing light → delete
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        this._deleteLight(hitIdx);
        return;
      }
      // Click on existing light → select
      this._selectedIndex = hitIdx;
      this._resetFadeTimer();
      return;
    }

    // Click on empty space
    if (this._selectedIndex >= 0) {
      // Deselect
      this._selectedIndex = -1;
      return;
    }

    // Place new light
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const paletteSlot = (e.metaKey || e.ctrlKey) ? sceneStore.get().palette.activeIndex : -1;

    pushHistory();
    const newLight: LightDef = {
      x: nx,
      y: ny,
      coreRadius: 0.02,
      bloomRadius: 0.08,
      intensity: 0.6,
      aspectRatio: 1.0,
      rotation: 0,
      paletteSlot,
      colorR: 1.0,
      colorG: 0.85,
      colorB: 0.6,
      depth: 0.5,
    };

    const currentLen = sceneStore.get().lights.length;
    sceneStore.update((s) => ({
      lights: [...s.lights, newLight],
    }));
    this._placedIndex = currentLen;
    this._placeDragStart = { x: nx, y: ny };
    this._selectedIndex = this._placedIndex;
    this._resetFadeTimer();
  }

  private _onCanvasPointerMove(e: PointerEvent) {
    if (!this._placeDragStart || this._placedIndex < 0) return;

    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const dx = nx - this._placeDragStart.x;
    const dy = ny - this._placeDragStart.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 0.01) {
      const idx = this._placedIndex;
      sceneStore.update((s) => {
        const lights = [...s.lights];
        if (lights[idx]) {
          lights[idx] = { ...lights[idx], bloomRadius: Math.max(0.02, dist) };
        }
        return { lights };
      });
    }
  }

  private _onCanvasPointerUp(_e: PointerEvent) {
    this._placeDragStart = null;
    this._placedIndex = -1;
  }

  private _onWheel(e: WheelEvent) {
    if (this._selectedIndex < 0 || !this._isActive) return;
    e.preventDefault();

    const delta = e.deltaY > 0 ? -1 : 1;
    const idx = this._selectedIndex;
    this._resetFadeTimer();

    if (this._rKeyHeld) {
      // R + scroll → rotate
      sceneStore.update((s) => {
        const lights = [...s.lights];
        if (lights[idx]) {
          lights[idx] = { ...lights[idx], rotation: lights[idx].rotation + delta * 0.1 };
        }
        return { lights };
      });
    } else if (e.shiftKey) {
      // Shift+scroll → stretch aspect ratio
      const factor = delta > 0 ? 1.05 : 0.95;
      sceneStore.update((s) => {
        const lights = [...s.lights];
        if (lights[idx]) {
          lights[idx] = {
            ...lights[idx],
            aspectRatio: this.clamp(lights[idx].aspectRatio * factor, 0.2, 5.0),
          };
        }
        return { lights };
      });
    } else {
      // Plain scroll → adjust intensity
      sceneStore.update((s) => {
        const lights = [...s.lights];
        if (lights[idx]) {
          lights[idx] = {
            ...lights[idx],
            intensity: this.clamp(lights[idx].intensity + delta * 0.05, 0.05, 1.0),
          };
        }
        return { lights };
      });
    }
  }

  private _onLightPointerDown(e: PointerEvent, index: number) {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    // Cmd+click → delete
    if (e.metaKey || e.ctrlKey) {
      this._deleteLight(index);
      return;
    }

    this._gesturePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._selectedIndex = index;
    this._resetFadeTimer();

    if (this._gesturePointers.size === 1) {
      this._dragIndex = index;
    } else if (this._gesturePointers.size === 2) {
      this._dragIndex = -1;
      this._gestureIndex = index;
      const pts = [...this._gesturePointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      this._gestureBaseDist = Math.sqrt(dx * dx + dy * dy);
      this._gestureBaseAngle = Math.atan2(dy, dx);
      const light = this._lights[index];
      if (light) {
        this._gestureBaseCoreR = light.coreRadius;
        this._gestureBaseBloomR = light.bloomRadius;
        this._gestureBaseRot = light.rotation;
      }
    }
  }

  private _onLightPointerMove(e: PointerEvent) {
    this._gesturePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._gesturePointers.size === 2 && this._gestureIndex >= 0) {
      // Two-finger: pinch → scale radii, rotate → rotation
      const pts = [...this._gesturePointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const scaleRatio = dist / Math.max(this._gestureBaseDist, 1);
      const angleDelta = angle - this._gestureBaseAngle;
      const idx = this._gestureIndex;

      sceneStore.update((s) => {
        const lights = [...s.lights];
        lights[idx] = {
          ...lights[idx],
          coreRadius: this.clamp(this._gestureBaseCoreR * scaleRatio, 0.005, 0.2),
          bloomRadius: this.clamp(this._gestureBaseBloomR * scaleRatio, 0.01, 0.5),
          rotation: this._gestureBaseRot + angleDelta,
        };
        return { lights };
      });
      this._resetFadeTimer();
      return;
    }

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
    this._resetFadeTimer();
  }

  private _onLightPointerUp(e: PointerEvent) {
    this._gesturePointers.delete(e.pointerId);
    this._dragIndex = -1;
    if (this._gesturePointers.size < 2) {
      this._gestureIndex = -1;
    }
  }

  private _lightColor(light: LightDef): string {
    const r = Math.round(light.colorR * 255);
    const g = Math.round(light.colorG * 255);
    const b = Math.round(light.colorB * 255);
    return `rgba(${r}, ${g}, ${b}, ${light.intensity})`;
  }

  render() {
    const selected = this._selectedIndex >= 0 ? this._lights[this._selectedIndex] : null;

    return html`
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onCanvasPointerDown}
        @pointermove=${this._onCanvasPointerMove}
        @pointerup=${this._onCanvasPointerUp}
        @wheel=${this._onWheel}
      >
        ${this._isActive ? this._lights.map(
          (light, i) => html`
            <div
              class="light ${this._dragIndex === i ? 'dragging' : ''}"
              style="
                left: ${light.x * 100}%;
                top: ${light.y * 100}%;
                background: radial-gradient(circle, ${this._lightColor(light)}, transparent);
                box-shadow: 0 0 ${light.bloomRadius * 400}px ${this._lightColor(light)};
              "
              @pointerdown=${(e: PointerEvent) => this._onLightPointerDown(e, i)}
              @pointermove=${this._onLightPointerMove}
              @pointerup=${this._onLightPointerUp}
            ></div>
          `
        ) : ''}
        ${this._isActive && selected ? html`
          <div
            class="selection-ring ${this._selectionFaded ? 'faded' : ''}"
            style="
              left: ${selected.x * 100}%;
              top: ${selected.y * 100}%;
              width: ${Math.max(selected.coreRadius * 2 * 100, 2)}vw;
              height: ${Math.max(selected.coreRadius * 2 * 100 * selected.aspectRatio, 2)}vw;
              transform: translate(-50%, -50%) rotate(${selected.rotation}rad);
            "
          ></div>
        ` : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-light-wells': LightWells;
  }
}
