// Custom mood creator — pick 5 OKLCH hues or extract from a photo
import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { huesToMoodPiles, bendThroughMood, bentColorsToPiles, type OklchColor } from '../mood/oklch.js';
import { addCustomMood, addCustomMoodFromExtraction, getAllMoods } from '../mood/custom-moods.js';
import { extractHuesFromImage } from '../mood/photo-extract.js';
import { DEFAULT_COMPLEMENT, DEFAULT_LENS, type KColor } from '../mood/moods.js';
import { sessionStore } from '../session/session-state.js';
import { sampleTonalColumn } from '../painting/palette.js';

function colorToCSS(c: KColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

@customElement('ghz-mood-creator')
export class MoodCreator extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1100;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: rgba(5, 3, 10, 0.95);
      }

      :host([hidden]) { display: none; }

      .title {
        font-size: 14px;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: var(--ghz-text-dim);
        margin-bottom: 20px;
      }

      .hue-pickers {
        display: flex;
        gap: 16px;
        margin-bottom: 20px;
      }

      .hue-column {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }

      .hue-preview {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .hue-swatch {
        width: 36px;
        height: 56px;
        border-radius: 3px;
      }

      input[type="range"] {
        writing-mode: vertical-lr;
        direction: rtl;
        width: 24px;
        height: 120px;
        appearance: none;
        background: transparent;
      }

      input[type="range"]::-webkit-slider-runnable-track {
        width: 4px;
        background: linear-gradient(
          to top,
          hsl(0, 70%, 50%),
          hsl(60, 70%, 50%),
          hsl(120, 70%, 50%),
          hsl(180, 70%, 50%),
          hsl(240, 70%, 50%),
          hsl(300, 70%, 50%),
          hsl(360, 70%, 50%)
        );
        border-radius: 2px;
      }

      input[type="range"]::-webkit-slider-thumb {
        appearance: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: white;
        border: 2px solid rgba(0,0,0,0.3);
        margin-left: -4px;
        cursor: pointer;
      }

      .hue-label {
        font-size: 9px;
        color: var(--ghz-text-dim);
      }

      .name-input {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        padding: 8px 16px;
        color: var(--ghz-text);
        font-size: 12px;
        letter-spacing: 0.5px;
        text-align: center;
        width: 200px;
        margin-bottom: 16px;
      }

      .name-input:focus {
        outline: none;
        border-color: var(--ghz-accent);
      }

      .actions {
        display: flex;
        gap: 10px;
      }

      .action-btn {
        padding: 8px 24px;
        font-size: 11px;
        letter-spacing: 1px;
        text-transform: uppercase;
      }

      .drop-zone {
        margin-bottom: 16px;
        padding: 16px 32px;
        border: 2px dashed rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        font-size: 10px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.5px;
        text-align: center;
        cursor: pointer;
      }

      .drop-zone.dragover {
        border-color: var(--ghz-accent);
        color: var(--ghz-text);
      }
    `,
  ];

  @state() private _hues = [30, 15, 280, 210, 50];
  @state() private _name = 'My Mood';
  @state() private _visible = false;
  @state() private _dragover = false;
  @state() private _extractedColors: OklchColor[] | null = null;

  show() {
    this._visible = true;
    this.hidden = false;
    this._hues = [30, 15, 280, 210, 50];
    this._name = 'My Mood';
    this._extractedColors = null;
  }

  hide() {
    this._visible = false;
    this.hidden = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;  // Start hidden so host element doesn't block clicks
  }

  private _onHueChange(index: number, e: Event) {
    const value = parseFloat((e.target as HTMLInputElement).value);
    this._hues = this._hues.map((h, i) => i === index ? value : h);
  }

  private _onNameChange(e: Event) {
    this._name = (e.target as HTMLInputElement).value;
  }

  private _onCreate() {
    if (!this._name.trim()) return;
    if (this._extractedColors) {
      // Photo extraction path — bend through active mood's lens
      const moodIndex = sessionStore.get().moodIndex ?? 0;
      const mood = getAllMoods()[moodIndex];
      const lens = mood?.lens ?? DEFAULT_LENS;
      const bentOklch = bendThroughMood(this._extractedColors, lens, mood?.density ?? 0.4);
      const piles = bentColorsToPiles(bentOklch);
      addCustomMoodFromExtraction(this._name.trim(), piles, bentOklch);
    } else {
      // Manual slider path — existing behavior
      addCustomMood(this._name.trim(), [...this._hues]);
    }
    this.dispatchEvent(new CustomEvent('mood-created', { bubbles: true, composed: true }));
    this.hide();
  }

  private _onCancel() {
    this.hide();
  }

  private _onDrop(e: DragEvent) {
    e.preventDefault();
    this._dragover = false;
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) {
      this._extractFromImage(file);
    }
  }

  private _onDragOver(e: DragEvent) {
    e.preventDefault();
    this._dragover = true;
  }

  private _onDragLeave() {
    this._dragover = false;
  }

  private _onFileClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) this._extractFromImage(file);
    };
    input.click();
  }

  private async _extractFromImage(file: File) {
    const result = await extractHuesFromImage(file, true);
    this._extractedColors = result.colors;
    this._hues = result.colors.map(c => c.h);
    // Auto-name from filename
    const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    this._name = baseName.slice(0, 24);
  }

  render() {
    if (!this._visible) return nothing;

    let piles;
    if (this._extractedColors) {
      const moodIndex = sessionStore.get().moodIndex ?? 0;
      const mood = getAllMoods()[moodIndex];
      const lens = mood?.lens ?? DEFAULT_LENS;
      const bentOklch = bendThroughMood(this._extractedColors, lens, mood?.density ?? 0.4);
      piles = bentColorsToPiles(bentOklch);
    } else {
      piles = huesToMoodPiles(this._hues);
    }

    return html`
      <span class="title">create custom mood</span>

      <div class="drop-zone ${this._dragover ? 'dragover' : ''}"
           @drop=${this._onDrop}
           @dragover=${this._onDragOver}
           @dragleave=${this._onDragLeave}
           @click=${this._onFileClick}>
        drop a photo or click to extract colors
      </div>

      <div class="hue-pickers">
        ${this._hues.map((hue, i) => html`
          <div class="hue-column">
            <div class="hue-preview">
              ${(() => {
                const light = sampleTonalColumn(piles[i].medium, 0.0, DEFAULT_COMPLEMENT);
                const dark = sampleTonalColumn(piles[i].medium, 1.0, DEFAULT_COMPLEMENT);
                return html`<div class="hue-swatch" style="background: linear-gradient(to bottom, ${colorToCSS(light)}, ${colorToCSS(piles[i].medium)} 50%, ${colorToCSS(dark)})"></div>`;
              })()}
            </div>
            <input type="range" min="0" max="360" .value=${String(hue)}
                   @input=${(e: Event) => this._onHueChange(i, e)} />
            <span class="hue-label">${Math.round(hue)}</span>
          </div>
        `)}
      </div>

      <input class="name-input" type="text" .value=${this._name}
             @input=${this._onNameChange}
             placeholder="mood name" maxlength="24" />

      <div class="actions">
        <button class="glass-button action-btn" @click=${this._onCancel}>cancel</button>
        <button class="glass-button action-btn" @click=${this._onCreate}>create</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-mood-creator': MoodCreator;
  }
}
