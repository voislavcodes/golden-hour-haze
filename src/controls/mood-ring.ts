import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import type { PaletteColor } from '../layers/layer-types.js';

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
        height: 80px;
      }

      .swatch {
        position: absolute;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        cursor: pointer;
        border: 2px solid transparent;
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

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    const palette = sceneStore.get().palette;
    this._colors = palette.colors;
    this._activeIndex = palette.activeIndex;

    this._unsubscribe = sceneStore.select(
      (s) => s.palette,
      (palette) => {
        this._colors = palette.colors;
        this._activeIndex = palette.activeIndex;
      }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _selectColor(index: number) {
    sceneStore.update((s) => ({
      palette: { ...s.palette, activeIndex: index },
    }));
  }

  private _colorToCSS(c: PaletteColor): string {
    return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
  }

  /** Position swatches in a circle */
  private _swatchPosition(index: number, total: number): { x: number; y: number } {
    const radius = 28;
    const centerX = 40 - 10; // ring center minus half swatch width
    const centerY = 40 - 10;
    const angleOffset = -Math.PI / 2; // start at top
    const angle = angleOffset + (index / total) * Math.PI * 2;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  }

  render() {
    return html`
      <div class="ring-container">
        <div class="ring">
          ${this._colors.map((color, i) => {
            const pos = this._swatchPosition(i, this._colors.length);
            return html`
              <div
                class="swatch ${this._activeIndex === i ? 'active' : ''}"
                style="
                  left: ${pos.x}px;
                  top: ${pos.y}px;
                  background: ${this._colorToCSS(color)};
                "
                @click=${() => this._selectColor(i)}
              ></div>
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
