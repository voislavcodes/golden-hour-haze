// Palette panel — 5 tonal column swatches
// Adapted from V1 mood-ring.ts, renamed to palette-panel.ts

import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore, type PaletteColor } from '../state/scene-state.js';
import { sampleTonalColumn } from '../painting/palette.js';
import { reloadBrush } from '../painting/brush-engine.js';

@customElement('ghz-palette-panel')
export class PalettePanel extends BaseControl {
  @state() private colors: PaletteColor[] = [];
  @state() private activeIndex = 0;
  @state() private tonalValues: number[] = [];

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
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
        padding: 6px;
        width: 120px;
      }
      .swatch {
        width: 32px;
        height: 32px;
        border-radius: 6px;
        border: 2px solid transparent;
        cursor: pointer;
        position: relative;
        transition: border-color 180ms ease;
      }
      .swatch.active {
        border-color: var(--ghz-accent);
        box-shadow: 0 0 8px rgba(232, 168, 64, 0.4);
      }
      .value-line {
        position: absolute;
        bottom: 0;
        left: 2px;
        right: 2px;
        height: 2px;
        background: rgba(255, 255, 255, 0.6);
        border-radius: 1px;
        pointer-events: none;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    const scene = sceneStore.get();
    this.colors = scene.palette.colors;
    this.activeIndex = scene.palette.activeIndex;
    this.tonalValues = scene.palette.tonalValues;

    sceneStore.subscribe((s) => {
      this.colors = s.palette.colors;
      this.activeIndex = s.palette.activeIndex;
      this.tonalValues = s.palette.tonalValues;
    });
  }

  private selectSwatch(index: number) {
    sceneStore.update((s) => ({
      palette: { ...s.palette, activeIndex: index },
    }));
    reloadBrush();
  }

  private handleWheel(e: WheelEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const delta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * 0.002, 0.05);
    sceneStore.update((s) => {
      const newValues = [...s.palette.tonalValues];
      newValues[index] = Math.max(0, Math.min(1, newValues[index] + delta));
      return { palette: { ...s.palette, tonalValues: newValues } };
    });
    reloadBrush();
  }

  private handleDblClick(index: number) {
    sceneStore.update((s) => {
      const newValues = [...s.palette.tonalValues];
      newValues[index] = 0.5;
      return { palette: { ...s.palette, tonalValues: newValues } };
    });
    reloadBrush();
  }

  private getSwatchColor(index: number): string {
    const base = this.colors[index];
    if (!base) return '#333';
    const value = this.tonalValues[index] ?? 0.5;
    const sampled = sampleTonalColumn(base, value);
    return `rgb(${Math.round(sampled.r * 255)}, ${Math.round(sampled.g * 255)}, ${Math.round(sampled.b * 255)})`;
  }

  render() {
    return html`
      <div class="panel glass">
        ${this.colors.map((_, i) => html`
          <div
            class="swatch ${i === this.activeIndex ? 'active' : ''}"
            style="background: ${this.getSwatchColor(i)}"
            @click=${() => this.selectSwatch(i)}
            @wheel=${(e: WheelEvent) => this.handleWheel(e, i)}
            @dblclick=${() => this.handleDblClick(i)}
          >
            <div class="value-line" style="bottom: ${(this.tonalValues[i] ?? 0.5) * 100}%"></div>
          </div>
        `)}
      </div>
    `;
  }
}
