// 5 scrollable tonal column swatches + rag
import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { dipBrush, wipeOnRag, getActiveHue, sampleTonalColumn, getActiveComplement, toggleOil, isOilArmed, toggleAnchor, isAnchorArmed, getAnchorRemaining, previewColor } from '../painting/palette.js';
import { reloadBrush, wipeBrush } from '../painting/brush-engine.js';
import type { KColor } from '../mood/moods.js';

function colorToCSS(c: KColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

@customElement('ghz-palette-panel')
export class PalettePanel extends BaseControl {
  @state() private _activeHue = 0;
  @state() private _tonalValues = [0.5, 0.5, 0.5, 0.5, 0.5];
  @state() private _oilArmed = false;
  @state() private _anchorArmed = false;

  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 100;
        pointer-events: auto;
      }
      .panel {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px;
      }
      .columns {
        display: flex;
        gap: 4px;
        justify-content: center;
      }
      .column {
        position: relative;
        width: 20px;
        height: 48px;
        border-radius: 4px;
        border: 2px solid transparent;
        cursor: pointer;
        transition: border-color 180ms ease;
        overflow: hidden;
      }
      .column:hover {
        border-color: rgba(255, 200, 120, 0.3);
      }
      .column.active {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 8px rgba(232, 168, 64, 0.4);
      }
      .indicator {
        position: absolute;
        left: 0;
        right: 0;
        height: 2px;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
        pointer-events: none;
      }
      .rag {
        margin-top: 4px;
        padding: 6px;
        font-size: 10px;
        text-align: center;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        cursor: pointer;
      }
      .oil-btn {
        margin-top: 2px;
        padding: 6px;
        font-size: 10px;
        text-align: center;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 180ms ease;
      }
      .oil-btn.armed {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 10px rgba(232, 168, 64, 0.6);
        color: var(--ghz-accent);
      }
      .previews {
        display: flex;
        gap: 4px;
        justify-content: center;
        margin-bottom: 2px;
      }
      .preview-swatch {
        width: 20px;
        height: 16px;
        border-radius: 3px;
        border: 1.5px solid rgba(255, 255, 255, 0.15);
        transition: background-color 180ms ease;
      }
      .preview-swatch.active {
        border-color: var(--ghz-accent);
      }
      .anchor-btn {
        margin-top: 2px;
        padding: 6px;
        font-size: 10px;
        text-align: center;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 180ms ease;
      }
      .anchor-btn.armed {
        border-color: #40c8e8;
        box-shadow: 0 0 10px rgba(64, 200, 232, 0.6);
        color: #40c8e8;
      }
    `,
  ];

  private _unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._activeHue = getActiveHue();
    this._oilArmed = isOilArmed();
    this._anchorArmed = isAnchorArmed();
    const palette = sceneStore.get().palette;
    this._tonalValues = [...palette.tonalValues];
    document.addEventListener('oil-changed', this._onOilChanged);
    document.addEventListener('anchor-changed', this._onAnchorChanged);
    this._unsub = sceneStore.select(
      (s) => s.palette,
      (palette) => {
        this._tonalValues = [...palette.tonalValues];
        this.requestUpdate();
      }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    document.removeEventListener('oil-changed', this._onOilChanged);
    document.removeEventListener('anchor-changed', this._onAnchorChanged);
  }

  private _isAnchorPreview(): boolean {
    return isAnchorArmed() || getAnchorRemaining() > 0;
  }

  private _gradientCSS(baseColor: KColor): string {
    const comp = getActiveComplement();
    const anchored = this._isAnchorPreview();
    const stops = [0.0, 0.25, 0.5, 0.65, 0.80, 0.92, 1.0];
    return `linear-gradient(to bottom, ${
      stops.map(v => {
        const raw = sampleTonalColumn(baseColor, v, comp);
        const display = previewColor(raw, anchored);
        return `${colorToCSS(display)} ${v * 100}%`;
      }).join(', ')
    })`;
  }

  private _onOilChanged = () => { this._oilArmed = isOilArmed(); };
  private _onOilClick() { toggleOil(); }
  private _onAnchorChanged = () => { this._anchorArmed = isAnchorArmed(); };
  private _onAnchorClick() { toggleAnchor(); }

  private _onColumnClick(index: number) {
    dipBrush(index);
    reloadBrush();
    this._activeHue = index;
    this._oilArmed = isOilArmed();
    this._anchorArmed = isAnchorArmed();
    sceneStore.update((s) => ({
      palette: { ...s.palette, activeIndex: index },
    }));
  }

  private _onColumnWheel(index: number, e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY * 0.002;
    const palette = sceneStore.get().palette;
    const newValues = [...palette.tonalValues];
    newValues[index] = Math.max(0, Math.min(1, newValues[index] + delta));
    sceneStore.update((s) => ({
      palette: { ...s.palette, tonalValues: newValues, activeIndex: index },
    }));
    dipBrush(index);
    reloadBrush();
    this._activeHue = index;
    this._oilArmed = isOilArmed();
    this._anchorArmed = isAnchorArmed();
  }

  private _onColumnDblClick(index: number) {
    const palette = sceneStore.get().palette;
    const newValues = [...palette.tonalValues];
    newValues[index] = 0.5;
    sceneStore.update((s) => ({
      palette: { ...s.palette, tonalValues: newValues, activeIndex: index },
    }));
    dipBrush(index);
    reloadBrush();
    this._activeHue = index;
    this._oilArmed = isOilArmed();
    this._anchorArmed = isAnchorArmed();
  }

  private _onRagClick() {
    wipeOnRag();
    wipeBrush();
    this.requestUpdate();
  }

  render() {
    const palette = sceneStore.get().palette;
    const colors = palette.colors;

    return html`
      <div class="panel glass">
        <div class="previews">
          ${colors.map((color, i) => {
            const baseColor: KColor = { r: color.r, g: color.g, b: color.b };
            const raw = sampleTonalColumn(baseColor, this._tonalValues[i], getActiveComplement());
            const display = previewColor(raw, this._isAnchorPreview());
            return html`
              <div class="preview-swatch ${this._activeHue === i ? 'active' : ''}"
                   style="background: ${colorToCSS(display)}"></div>
            `;
          })}
        </div>
        <div class="columns">
          ${colors.map((color, i) => {
            const baseColor: KColor = { r: color.r, g: color.g, b: color.b };
            const indicatorY = this._tonalValues[i] * 44; // 48px height - 4px border
            return html`
              <div
                class="column ${this._activeHue === i ? 'active' : ''}"
                style="background: ${this._gradientCSS(baseColor)}"
                @click=${() => this._onColumnClick(i)}
                @wheel=${(e: WheelEvent) => this._onColumnWheel(i, e)}
                @dblclick=${() => this._onColumnDblClick(i)}
              >
                <div class="indicator" style="top: ${indicatorY}px"></div>
              </div>
            `;
          })}
        </div>
        <button class="glass-button rag" @click=${this._onRagClick}>rag (X)</button>
        <button class="glass-button oil-btn ${this._oilArmed ? 'armed' : ''}"
                @click=${this._onOilClick}>oil (O)</button>
        <button class="glass-button anchor-btn ${this._anchorArmed ? 'armed' : ''}"
                @click=${this._onAnchorClick}>anchor (A)</button>
      </div>
    `;
  }
}
