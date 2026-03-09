import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { exportViewport } from '../export/png-export.js';

@customElement('ghz-export-button')
export class ExportButton extends BaseControl {
  static override styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 100;
      }

      button {
        padding: 6px 14px;
        font-size: 11px;
        letter-spacing: 0.08em;
        font-weight: 600;
      }

      button[disabled] {
        opacity: 0.5;
        cursor: default;
        pointer-events: none;
      }
    `,
  ];

  @state() private _exporting = false;

  private async _handleClick() {
    const canvas = document.querySelector<HTMLCanvasElement>('#ghz');
    if (!canvas || this._exporting) return;

    this._exporting = true;
    try {
      await exportViewport(canvas);
    } catch (e) {
      console.error('Export failed:', e);
    } finally {
      // Brief visual feedback before re-enabling
      setTimeout(() => {
        this._exporting = false;
      }, 600);
    }
  }

  override render() {
    return html`
      <button
        class="glass-button"
        ?disabled=${this._exporting}
        @click=${this._handleClick}
      >
        ${this._exporting ? 'SAVING\u2026' : 'PNG'}
      </button>
    `;
  }
}
