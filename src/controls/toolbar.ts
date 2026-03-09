import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { uiStore, type Tool } from '../state/ui-state.js';

interface ToolEntry {
  id: Tool;
  label: string;
  shortcut: string;
}

const TOOLS: ToolEntry[] = [
  { id: 'select',   label: 'SEL',  shortcut: 'V' },
  { id: 'form',     label: 'FRM',  shortcut: 'F' },
  { id: 'light',    label: 'LGT',  shortcut: 'L' },
  { id: 'scrape',   label: 'SCRP', shortcut: 'D' },
  { id: 'wipe',     label: 'WIPE', shortcut: 'W' },
  { id: 'drift',    label: 'DRFT', shortcut: 'R' },
  { id: 'palette',  label: 'PAL',  shortcut: 'P' },
  { id: 'anchor',   label: 'ANCR', shortcut: 'A' },
];

@customElement('ghz-toolbar')
export class Toolbar extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100;
        pointer-events: auto;
      }

      .toolbar {
        display: flex;
        gap: 4px;
        padding: 6px;
        align-items: center;
      }

      .tool-btn {
        width: 44px;
        height: 36px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 4px 6px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
        line-height: 1;
        gap: 2px;
      }

      .tool-btn .shortcut {
        font-size: 8px;
        opacity: 0.4;
        font-weight: 400;
      }

      .tool-btn.active .shortcut {
        opacity: 0.7;
      }
    `,
  ];

  @state()
  private _activeTool: Tool = 'form';

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._activeTool = uiStore.get().activeTool;
    this._unsubscribe = uiStore.select(
      (s) => s.activeTool,
      (tool) => { this._activeTool = tool; }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private _selectTool(tool: Tool) {
    uiStore.set({ activeTool: tool });
  }

  render() {
    return html`
      <div class="toolbar glass">
        ${TOOLS.map(
          (t) => html`
            <button
              class="glass-button tool-btn ${this._activeTool === t.id ? 'active' : ''}"
              @click=${() => this._selectTool(t.id)}
              title="${t.id} (${t.shortcut})"
            >
              <span>${t.label}</span>
              <span class="shortcut">${t.shortcut}</span>
            </button>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-toolbar': Toolbar;
  }
}
