import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';

/**
 * Placeholder component for predicted stroke continuations.
 * Will be implemented with AI-driven stroke prediction in a future iteration.
 */
@customElement('ghz-ghost-strokes')
export class GhostStrokes extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 13;
        pointer-events: none;
      }
    `,
  ];

  render() {
    return html``;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-ghost-strokes': GhostStrokes;
  }
}
