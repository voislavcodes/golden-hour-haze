import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';

@customElement('ghz-echo-slider')
export class EchoSlider extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100;
        pointer-events: auto;
      }

      .slider-container {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
      }

      .slider-label {
        font-size: 9px;
        color: var(--ghz-text-dim);
        letter-spacing: 0.8px;
        text-transform: uppercase;
        white-space: nowrap;
      }

      .slider-value {
        font-size: 10px;
        color: var(--ghz-accent);
        font-variant-numeric: tabular-nums;
        min-width: 32px;
        text-align: right;
      }

      input[type="range"] {
        -webkit-appearance: none;
        appearance: none;
        width: 120px;
        height: 4px;
        background: linear-gradient(
          to right,
          var(--ghz-accent) 0%,
          var(--ghz-accent) var(--fill, 50%),
          rgba(255, 255, 255, 0.1) var(--fill, 50%),
          rgba(255, 255, 255, 0.1) 100%
        );
        border-radius: 2px;
        outline: none;
        cursor: pointer;
      }

      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--ghz-accent);
        border: 2px solid rgba(0, 0, 0, 0.3);
        box-shadow: 0 0 6px rgba(232, 168, 64, 0.4);
        cursor: grab;
      }

      input[type="range"]::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--ghz-accent);
        border: 2px solid rgba(0, 0, 0, 0.3);
        box-shadow: 0 0 6px rgba(232, 168, 64, 0.4);
        cursor: grab;
      }

      input[type="range"]:active::-webkit-slider-thumb {
        cursor: grabbing;
      }
    `,
  ];

  @property({ type: Number })
  value: number = 0.5;

  private _unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.value = sceneStore.get().echo;
    this._unsub = sceneStore.select(
      (s) => s.echo,
      (echo) => { this.value = echo; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  private _onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.value = parseFloat(input.value);
    sceneStore.set({ echo: this.value });
  }

  render() {
    const fillPercent = this.value * 100;
    return html`
      <div class="slider-container glass">
        <span class="slider-label">echo</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          .value=${String(this.value)}
          style="--fill: ${fillPercent}%"
          @input=${this._onInput}
        />
        <span class="slider-value">${this.value.toFixed(2)}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-echo-slider': EchoSlider;
  }
}
