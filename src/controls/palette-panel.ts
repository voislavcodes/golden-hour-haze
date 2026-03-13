// 5x5 Meldrum tonal grid — 5 hues × 5 discrete tones + rag/oil/anchor
import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { dipBrush, wipeOnRag, getActiveHue, sampleTonalColumn, getActiveComplement, toggleOil, isOilArmed, toggleAnchor, isAnchorArmed, getAnchorRemaining, previewColor, MELDRUM_VALUES } from '../painting/palette.js';
import { reloadBrush, wipeBrush } from '../painting/brush-engine.js';
import type { KColor } from '../mood/moods.js';

function colorToCSS(c: KColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

@customElement('ghz-palette-panel')
export class PalettePanel extends BaseControl {
  @state() private _activeHue = 0;
  @state() private _activeTonalIndex = 2;
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
      .grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 3px;
      }
      .swatch {
        width: 36px;
        height: 36px;
        border-radius: 4px;
        border: 2px solid transparent;
        cursor: pointer;
        transition: border-color 180ms ease, box-shadow 180ms ease;
      }
      .swatch:hover {
        border-color: rgba(255, 200, 120, 0.3);
      }
      .swatch.active {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 8px rgba(232, 168, 64, 0.4);
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
    this._activeTonalIndex = palette.activeTonalIndex;
    document.addEventListener('oil-changed', this._onOilChanged);
    document.addEventListener('anchor-changed', this._onAnchorChanged);
    this._unsub = sceneStore.select(
      (s) => s.palette,
      (palette) => {
        this._activeTonalIndex = palette.activeTonalIndex;
        this._activeHue = palette.activeIndex;
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

  private _onOilChanged = () => { this._oilArmed = isOilArmed(); };
  private _onOilClick() { toggleOil(); }
  private _onAnchorChanged = () => { this._anchorArmed = isAnchorArmed(); };
  private _onAnchorClick() { toggleAnchor(); }

  private _onSwatchClick(hueIndex: number, tonalIndex: number) {
    const newValues = [...sceneStore.get().palette.tonalValues];
    newValues[hueIndex] = MELDRUM_VALUES[tonalIndex];
    sceneStore.update((s) => ({
      palette: { ...s.palette, tonalValues: newValues, activeIndex: hueIndex, activeTonalIndex: tonalIndex },
    }));
    dipBrush(hueIndex);
    reloadBrush();
    this._activeHue = hueIndex;
    this._activeTonalIndex = tonalIndex;
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
    const comp = getActiveComplement();
    const anchored = this._isAnchorPreview();

    return html`
      <div class="panel glass">
        <div class="grid">
          ${MELDRUM_VALUES.map((tonalValue, row) =>
            colors.map((color, col) => {
              const baseColor: KColor = { r: color.r, g: color.g, b: color.b };
              const raw = sampleTonalColumn(baseColor, tonalValue, comp);
              const display = previewColor(raw, anchored);
              const isActive = this._activeHue === col && this._activeTonalIndex === row;
              return html`
                <div
                  class="swatch ${isActive ? 'active' : ''}"
                  style="background: ${colorToCSS(display)}"
                  @click=${() => this._onSwatchClick(col, row)}
                ></div>
              `;
            })
          )}
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
