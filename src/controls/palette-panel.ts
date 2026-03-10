// 15-pile palette panel — 5 hues × 3 values (light/medium/dark) + rag
import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { getMoodPiles, dipBrush, wipeOnRag, getActivePile } from '../painting/palette.js';
import { reloadBrush } from '../painting/brush-engine.js';
import type { KColor } from '../mood/moods.js';

function colorToCSS(c: KColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

@customElement('ghz-palette-panel')
export class PalettePanel extends BaseControl {
  @state() private _activePile = 0;

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
      .pile-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 3px;
      }
      .swatch {
        width: 24px;
        height: 24px;
        border-radius: 4px;
        border: 2px solid transparent;
        cursor: pointer;
        transition: border-color 180ms ease;
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
      .label {
        font-size: 8px;
        text-align: center;
        color: var(--ghz-text-dim);
        letter-spacing: 0.5px;
        margin-top: 2px;
      }
      .row-labels {
        display: flex;
        flex-direction: column;
        gap: 3px;
        justify-content: center;
        padding-right: 4px;
      }
      .row-label {
        font-size: 7px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.3px;
        height: 24px;
        display: flex;
        align-items: center;
      }
      .grid-area {
        display: flex;
      }
    `,
  ];

  private _unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._activePile = getActivePile();
    this._unsub = sceneStore.select(
      (s) => s.mood,
      () => { this.requestUpdate(); }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  private _onPileClick(index: number) {
    dipBrush(index);
    reloadBrush();
    this._activePile = index;
  }

  private _onRagClick() {
    wipeOnRag();
    this.requestUpdate();
  }

  render() {
    const piles = getMoodPiles();
    // Build 15 swatches: 3 rows (light/medium/dark) × 5 hues
    const rows = [
      piles.map(p => p.light),
      piles.map(p => p.medium),
      piles.map(p => p.dark),
    ];
    const rowLabels = ['LT', 'MD', 'DK'];

    return html`
      <div class="panel glass">
        <div class="grid-area">
          <div class="row-labels">
            ${rowLabels.map(l => html`<div class="row-label">${l}</div>`)}
          </div>
          <div class="pile-grid">
            ${rows.flatMap((row, rowIdx) =>
              row.map((color, colIdx) => {
                const idx = colIdx * 3 + rowIdx; // 0-14 pile index
                return html`
                  <div
                    class="swatch ${this._activePile === idx ? 'active' : ''}"
                    style="background: ${colorToCSS(color)}"
                    @click=${() => this._onPileClick(idx)}
                  ></div>
                `;
              })
            )}
          </div>
        </div>
        <button class="glass-button rag" @click=${this._onRagClick}>rag (X)</button>
      </div>
    `;
  }
}
