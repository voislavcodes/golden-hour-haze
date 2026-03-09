import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import type { PaletteColor } from '../layers/layer-types.js';
import { sampleTonalColumn } from '../layers/tonal-column.js';

@customElement('ghz-mood-ring')
export class MoodRing extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 80px;
        left: 20px;
        z-index: 100;
        pointer-events: auto;
      }

      .ring-container {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .ring {
        position: relative;
        width: 80px;
        height: 88px;
      }

      .swatch {
        position: absolute;
        width: 20px;
        height: 40px;
        border-radius: 4px;
        cursor: pointer;
        border: 2px solid transparent;
        overflow: hidden;
        transition: border-color var(--ghz-transition),
                    transform var(--ghz-transition),
                    box-shadow var(--ghz-transition);
      }

      .swatch:hover {
        transform: scale(1.15);
      }

      .swatch.active {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 10px rgba(232, 168, 64, 0.4);
        transform: scale(1.2);
      }

      .value-indicator {
        position: absolute;
        left: 0;
        width: 100%;
        height: 2px;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
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
    `,
  ];

  @state() private _colors: PaletteColor[] = [];
  @state() private _activeIndex: number = 0;
  @state() private _tonalValues: number[] = [];

  private _unsubscribe?: () => void;
  private _wheelHandler?: (e: WheelEvent) => void;

  connectedCallback() {
    super.connectedCallback();
    const palette = sceneStore.get().palette;
    this._colors = palette.colors;
    this._activeIndex = palette.activeIndex;
    this._tonalValues = palette.tonalValues ?? palette.colors.map(() => 0.5);

    this._unsubscribe = sceneStore.select(
      (s) => s.palette,
      (palette) => {
        this._colors = palette.colors;
        this._activeIndex = palette.activeIndex;
        this._tonalValues = palette.tonalValues ?? palette.colors.map(() => 0.5);
      }
    );
  }

  protected firstUpdated() {
    // Add wheel listener imperatively with {passive: false} so preventDefault works
    const ring = this.shadowRoot!.querySelector('.ring');
    if (ring) {
      this._wheelHandler = (e: WheelEvent) => {
        const swatch = (e.target as HTMLElement).closest('.swatch') as HTMLElement | null;
        if (!swatch) return;
        const idx = Number(swatch.dataset.index);
        if (isNaN(idx)) return;
        e.preventDefault();
        e.stopPropagation();
        const current = sceneStore.get().palette.tonalValues?.[idx] ?? 0.5;
        const newValue = Math.max(0, Math.min(1, current + e.deltaY * 0.002));
        sceneStore.update((s) => {
          const vals = [...(s.palette.tonalValues ?? s.palette.colors.map(() => 0.5))];
          vals[idx] = newValue;
          return { palette: { ...s.palette, tonalValues: vals } };
        });
      };
      ring.addEventListener('wheel', this._wheelHandler as EventListener, { passive: false });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    if (this._wheelHandler) {
      const ring = this.shadowRoot?.querySelector('.ring');
      ring?.removeEventListener('wheel', this._wheelHandler as EventListener);
    }
  }

  private _selectColor(index: number) {
    sceneStore.update((s) => ({
      palette: { ...s.palette, activeIndex: index },
    }));
  }

  private _onSwatchDblClick(e: MouseEvent, index: number) {
    e.preventDefault();
    sceneStore.update((s) => {
      const vals = [...(s.palette.tonalValues ?? s.palette.colors.map(() => 0.5))];
      vals[index] = 0.5;
      return { palette: { ...s.palette, tonalValues: vals } };
    });
  }

  private _rgbToCSS(c: { r: number; g: number; b: number }): string {
    return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
  }

  private _tonalGradient(color: PaletteColor): string {
    const stops = [0, 0.25, 0.5, 0.75, 1.0];
    const cssStops = stops.map(v => {
      const c = sampleTonalColumn(color, v);
      return `${this._rgbToCSS(c)} ${v * 100}%`;
    });
    return `linear-gradient(to bottom, ${cssStops.join(', ')})`;
  }

  /** Position swatches in 3-over-2 grid */
  private _swatchPosition(index: number): { x: number; y: number } {
    const spacing = 24;
    if (index < 3) {
      const rowWidth = 2 * spacing;
      const startX = (80 - rowWidth) / 2 - 10;
      return { x: startX + index * spacing, y: 0 };
    }
    const rowWidth = spacing;
    const startX = (80 - rowWidth) / 2 - 10;
    return { x: startX + (index - 3) * spacing, y: 44 };
  }

  render() {
    return html`
      <div class="ring-container">
        <div class="ring">
          ${this._colors.map((color, i) => {
            const pos = this._swatchPosition(i);
            const value = this._tonalValues[i] ?? 0.5;
            return html`
              <div
                class="swatch ${this._activeIndex === i ? 'active' : ''}"
                data-index="${i}"
                style="
                  left: ${pos.x}px;
                  top: ${pos.y}px;
                  background: ${this._tonalGradient(color)};
                "
                @click=${() => this._selectColor(i)}
                @dblclick=${(e: MouseEvent) => this._onSwatchDblClick(e, i)}
              >
                <div class="value-indicator" style="top: ${value * 36}px"></div>
              </div>
            `;
          })}
        </div>
        <div class="label">palette</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-mood-ring': MoodRing;
  }
}
