import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import type { AtmosphereParams } from '../layers/layer-types.js';

@customElement('ghz-atmosphere-orb')
export class AtmosphereOrb extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 248px;
        right: 20px;
        z-index: 100;
        pointer-events: auto;
      }

      .orb-container {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .orb {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        cursor: grab;
        border: 1px solid var(--ghz-glass-border);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5),
                    inset 0 0 20px rgba(232, 168, 64, 0.15);
        transition: box-shadow var(--ghz-transition);
        touch-action: none;
        position: relative;
      }

      .orb:hover {
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6),
                    inset 0 0 24px rgba(232, 168, 64, 0.25);
      }

      .orb.dragging {
        cursor: grabbing;
        box-shadow: 0 4px 28px rgba(0, 0, 0, 0.7),
                    inset 0 0 28px rgba(232, 168, 64, 0.35);
      }

      .position-dot {
        position: absolute;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ghz-accent);
        box-shadow: 0 0 4px rgba(232, 168, 64, 0.8);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .label {
        text-align: center;
        font-size: 9px;
        color: var(--ghz-text-dim);
        margin-top: 6px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }

      .preset-dots {
        display: flex;
        gap: 4px;
        justify-content: center;
        margin-top: 4px;
      }

      .preset-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        border: 1px solid var(--ghz-text-dim);
        opacity: 0.4;
      }

      .preset-dot.filled {
        background: var(--ghz-accent);
        opacity: 0.8;
      }
    `,
  ];

  @state() private _density: number = 0.5;
  @state() private _warmth: number = 0.3;
  @state() private _grainDepth: number = 0.5;
  @state() private _dragging: boolean = false;
  @state() private _sunWarmth: number = 0;
  @state() private _presets: (AtmosphereParams | null)[] = [null, null, null, null];

  private _startX = 0;
  private _startY = 0;
  private _startWarmth = 0;
  private _startDensity = 0;
  private _unsubscribe?: () => void;
  private _unsubPresets?: () => void;

  connectedCallback() {
    super.connectedCallback();
    const s = sceneStore.get();
    this._density = s.atmosphere.density;
    this._warmth = s.atmosphere.warmth;
    this._grainDepth = s.atmosphere.grainDepth;
    this._presets = s.orbPresets;

    this._unsubscribe = sceneStore.select(
      (s) => s.atmosphere,
      (atmo) => {
        this._density = atmo.density;
        this._warmth = atmo.warmth;
        this._grainDepth = atmo.grainDepth;
      }
    );

    // Track sun warmth for orb gradient
    sceneStore.select(
      (s) => s.sunAngle,
      (angle) => {
        // Map sun angle to warmth influence (golden hour = warm, blue hour = cool)
        const gd = angle - 0.75;
        const bd = angle - 5.5;
        this._sunWarmth = Math.exp(-gd * gd * 2) - Math.exp(-bd * bd * 2) * 0.5;
      }
    );

    this._unsubPresets = sceneStore.select(
      (s) => s.orbPresets,
      (presets) => { this._presets = presets; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubPresets?.();
  }

  private _onPointerDown(e: PointerEvent) {
    // Cmd+click: save preset
    if (e.metaKey) {
      const presets = [...sceneStore.get().orbPresets];
      const emptyIdx = presets.findIndex((p) => p === null);
      const idx = emptyIdx >= 0 ? emptyIdx : 0; // cycle to 0 if all full
      presets[idx] = { ...sceneStore.get().atmosphere };
      sceneStore.set({ orbPresets: presets });
      return;
    }

    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._startWarmth = this._warmth;
    this._startDensity = this._density;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._dragging) return;

    const dx = e.clientX - this._startX;
    const dy = e.clientY - this._startY;

    // X drag: warmth (-1 to 1)
    const newWarmth = this.clamp(this._startWarmth + dx * 0.008, -1, 1);
    // Y drag: density (0-1), up=thin, down=dense
    const newDensity = this.clamp(this._startDensity + dy * 0.005, 0, 1);

    this._warmth = newWarmth;
    this._density = newDensity;

    // Compute derived scatter from density and warmth
    const humidity = newDensity * (1 - Math.abs(newWarmth)) * 0.8;
    const scatter = newDensity * 0.8 + humidity * 0.2;

    sceneStore.update((s) => ({
      atmosphere: { ...s.atmosphere, density: newDensity, warmth: newWarmth, scatter },
    }));
  }

  private _onPointerUp(_e: PointerEvent) {
    this._dragging = false;
  }

  private _onWheel(e: WheelEvent) {
    e.preventDefault();
    const newGrainDepth = this.clamp(this._grainDepth - e.deltaY * 0.002, 0, 1);
    this._grainDepth = newGrainDepth;
    sceneStore.update((s) => ({
      atmosphere: { ...s.atmosphere, grainDepth: newGrainDepth },
    }));
  }

  private get _gradient(): string {
    const warmHue = 30 + (this._warmth + this._sunWarmth * 0.5) * 25;
    const coolHue = 240 - (this._warmth + this._sunWarmth * 0.5) * 30;
    const densityAlpha = 0.3 + this._density * 0.5;
    return `radial-gradient(
      circle at 35% 35%,
      hsla(${warmHue}, 80%, 65%, ${densityAlpha}),
      hsla(${coolHue}, 40%, 25%, ${densityAlpha * 0.8}),
      hsla(260, 30%, 12%, ${densityAlpha * 0.6})
    )`;
  }

  /** Grain depth ring width */
  private get _ringWidth(): number {
    return 1 + this._grainDepth * 3;
  }

  /** Position dot coordinates (percentage) */
  private get _dotLeft(): number {
    return (this._warmth + 1) * 50;
  }

  private get _dotTop(): number {
    return this._density * 100;
  }

  private get _modeHint(): string {
    if (this._warmth > 0.3 && this._density > 0.6) return 'warm fog';
    if (this._warmth < -0.3 && this._density < 0.3) return 'crisp air';
    if (this._density > 0.7) return 'dense';
    if (this._density < 0.2) return 'clear';
    return 'atmosphere';
  }

  render() {
    return html`
      <div class="orb-container">
        <div
          class="orb ${this._dragging ? 'dragging' : ''}"
          style="background: ${this._gradient}; border-width: ${this._ringWidth}px"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointerleave=${this._onPointerUp}
          @wheel=${this._onWheel}
        >
          <div
            class="position-dot"
            style="left: ${this._dotLeft}%; top: ${this._dotTop}%"
          ></div>
        </div>
        <div class="label">${this._modeHint}</div>
        <div class="preset-dots">
          ${this._presets.map((p) => html`
            <div class="preset-dot ${p ? 'filled' : ''}"></div>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-atmosphere-orb': AtmosphereOrb;
  }
}
