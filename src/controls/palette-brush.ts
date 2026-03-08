import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { BaseControl } from './base-control.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';

/**
 * When the palette tool is active, clicking the canvas auto-selects
 * a palette color based on the click position's simulated depth.
 * Deeper positions select cooler colors; shallower positions select warmer.
 */
@customElement('ghz-palette-brush')
export class PaletteBrush extends BaseControl {
  static styles = [
    BaseControl.baseStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 15;
        pointer-events: none;
      }

      :host(.active) {
        pointer-events: auto;
        cursor: copy;
      }

      .pick-indicator {
        position: absolute;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 2px solid var(--ghz-accent);
        transform: translate(-50%, -50%);
        pointer-events: none;
        opacity: 0;
        transition: opacity 300ms ease;
      }

      .pick-indicator.visible {
        opacity: 1;
      }
    `,
  ];

  @state() private _isActive: boolean = false;
  @state() private _pickX: number = 0;
  @state() private _pickY: number = 0;
  @state() private _pickVisible: boolean = false;
  @state() private _pickColor: string = 'transparent';

  private _unsubTool?: () => void;
  private _hideTimeout: number = 0;

  connectedCallback() {
    super.connectedCallback();
    this._isActive = uiStore.get().activeTool === 'palette';
    this._unsubTool = uiStore.select(
      (s) => s.activeTool,
      (tool) => {
        this._isActive = tool === 'palette';
        if (this._isActive) {
          this.classList.add('active');
        } else {
          this.classList.remove('active');
        }
      }
    );
    if (this._isActive) this.classList.add('active');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    if (this._hideTimeout) clearTimeout(this._hideTimeout);
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this._isActive) return;

    const rect = this.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    // Estimate depth from vertical position (top = far/deep, bottom = near/shallow)
    const estimatedDepth = ny;

    // Map depth to palette index: shallow (bottom) = warm colors (low index),
    // deep (top) = cool colors (high index)
    const palette = sceneStore.get().palette;
    const colorCount = palette.colors.length;
    const selectedIndex = this.clamp(
      Math.floor(estimatedDepth * colorCount),
      0,
      colorCount - 1
    );

    sceneStore.update((s) => ({
      palette: { ...s.palette, activeIndex: selectedIndex },
    }));

    // Show pick indicator
    const color = palette.colors[selectedIndex];
    this._pickX = nx * 100;
    this._pickY = ny * 100;
    this._pickColor = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${color.a})`;
    this._pickVisible = true;

    if (this._hideTimeout) clearTimeout(this._hideTimeout);
    this._hideTimeout = window.setTimeout(() => {
      this._pickVisible = false;
    }, 600);
  }

  render() {
    return html`
      <div
        style="width:100%;height:100%;position:relative;"
        @pointerdown=${this._onPointerDown}
      >
        <div
          class="pick-indicator ${this._pickVisible ? 'visible' : ''}"
          style="
            left: ${this._pickX}%;
            top: ${this._pickY}%;
            background: ${this._pickColor};
          "
        ></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ghz-palette-brush': PaletteBrush;
  }
}
