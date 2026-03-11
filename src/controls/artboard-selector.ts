import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { artboardStore, ARTBOARD_PRESETS } from '../state/artboard-state.js';

@customElement('ghz-artboard-selector')
export class ArtboardSelector extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }

      .cards {
        display: flex;
        gap: 10px;
      }

      .card {
        width: 120px;
        padding: 10px;
        cursor: pointer;
        transition: border-color 0.2s, box-shadow 0.2s;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }

      .card:hover {
        border-color: rgba(255, 200, 120, 0.4);
      }

      .card.selected {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 16px rgba(232, 168, 64, 0.25);
      }

      .card-name {
        font-size: 11px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: var(--ghz-text);
      }

      .card-dims {
        font-size: 9px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.3px;
      }

      .artboard-preview {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 40px;
      }

      .artboard-thumb {
        border: 1px solid rgba(255, 200, 120, 0.3);
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.05);
      }
    `,
  ];

  @state() private _selectedIndex = 0;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._selectedIndex = artboardStore.get().presetIndex;
    this._unsubscribe = artboardStore.select(
      (s) => s.presetIndex,
      (idx) => { this._selectedIndex = idx; },
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _select(index: number) {
    const preset = ARTBOARD_PRESETS[index];
    artboardStore.set({
      presetIndex: index,
      width: preset.width,
      height: preset.height,
    });
  }

  private _thumbSize(w: number, h: number): { tw: number; th: number } {
    const maxW = 60;
    const maxH = 36;
    const scale = Math.min(maxW / w, maxH / h);
    return { tw: Math.round(w * scale), th: Math.round(h * scale) };
  }

  render() {
    return html`
      <div class="cards">
        ${ARTBOARD_PRESETS.map((preset, i) => {
          const { tw, th } = this._thumbSize(preset.width, preset.height);
          return html`
            <div class="card glass ${this._selectedIndex === i ? 'selected' : ''}"
                 @click=${() => this._select(i)}>
              <div class="artboard-preview">
                <div class="artboard-thumb" style="width:${tw}px;height:${th}px"></div>
              </div>
              <span class="card-name">${preset.name}</span>
              <span class="card-dims">${preset.width} × ${preset.height}</span>
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-artboard-selector': ArtboardSelector;
  }
}
