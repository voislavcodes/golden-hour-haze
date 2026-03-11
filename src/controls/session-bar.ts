// Session bar — test/paint phase top-center controls
import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sessionStore, advancePhase, retreatPhase, resetToPrepare, type SessionPhase } from '../session/session-state.js';

@customElement('ghz-session-bar')
export class SessionBar extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        pointer-events: none;
      }

      :host([hidden]) {
        display: none;
      }

      .session-bar {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1001;
        display: flex;
        gap: 8px;
        align-items: center;
        pointer-events: auto;
      }

      .session-btn {
        padding: 6px 16px;
        font-size: 10px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .session-label {
        font-size: 10px;
        letter-spacing: 1px;
        color: var(--ghz-text-dim);
        text-transform: uppercase;
        padding: 0 8px;
      }
    `,
  ];

  @state() private _phase: SessionPhase = 'prepare';
  @state() private _confirmingPaint = false;
  @state() private _confirmingNew = false;
  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._phase = sessionStore.get().phase;
    this._unsubscribe = sessionStore.select(
      (s) => s.phase,
      (phase) => { this._phase = phase; },
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _startPainting() {
    if (!this._confirmingPaint) {
      this._confirmingPaint = true;
      return;
    }
    this._confirmingPaint = false;
    advancePhase();
    this.dispatchEvent(new CustomEvent('start-painting', { bubbles: true, composed: true }));
  }

  private _cancelStartPainting() {
    this._confirmingPaint = false;
  }

  private _back() {
    retreatPhase();
  }

  private _newPainting() {
    if (!this._confirmingNew) {
      this._confirmingNew = true;
      return;
    }
    this._confirmingNew = false;
    resetToPrepare();
    this.dispatchEvent(new CustomEvent('new-painting', { bubbles: true, composed: true }));
  }

  private _cancelNew() {
    this._confirmingNew = false;
  }

  render() {
    if (this._phase === 'test') {
      return html`
        <div class="session-bar">
          <button class="glass-button session-btn" @click=${this._back}>back</button>
          <span class="session-label">test canvas</span>
          ${this._confirmingPaint ? html`
            <span class="session-label" style="color: var(--ghz-accent)">clear test canvas?</span>
            <button class="glass-button session-btn" @click=${this._startPainting}>yes, start</button>
            <button class="glass-button session-btn" @click=${this._cancelStartPainting}>cancel</button>
          ` : html`
            <button class="glass-button session-btn active" @click=${this._startPainting}>start painting</button>
          `}
        </div>
      `;
    }

    if (this._phase === 'paint') {
      return html`
        <div class="session-bar">
          <span class="session-label">painting</span>
          ${this._confirmingNew ? html`
            <span class="session-label" style="color: var(--ghz-accent)">start new painting?</span>
            <button class="glass-button session-btn" @click=${this._newPainting}>yes</button>
            <button class="glass-button session-btn" @click=${this._cancelNew}>cancel</button>
          ` : html`
            <button class="glass-button session-btn" @click=${this._newPainting}>new painting</button>
          `}
        </div>
      `;
    }

    return nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-session-bar': SessionBar;
  }
}
