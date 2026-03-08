import { LitElement, css } from 'lit';

/**
 * Base class for all Golden Hour Haze UI controls.
 * Provides shared dark-theme glass-morphism styles.
 */
export class BaseControl extends LitElement {
  static baseStyles = css`
    :host {
      --ghz-glass-bg: rgba(15, 12, 20, 0.55);
      --ghz-glass-border: rgba(255, 200, 120, 0.15);
      --ghz-glass-blur: 12px;
      --ghz-accent: #e8a840;
      --ghz-accent-dim: rgba(232, 168, 64, 0.4);
      --ghz-text: #f0e6d2;
      --ghz-text-dim: rgba(240, 230, 210, 0.5);
      --ghz-shadow: rgba(0, 0, 0, 0.4);
      --ghz-radius: 8px;
      --ghz-transition: 180ms ease;

      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 12px;
      color: var(--ghz-text);
      box-sizing: border-box;
      user-select: none;
      -webkit-user-select: none;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    .glass {
      background: var(--ghz-glass-bg);
      backdrop-filter: blur(var(--ghz-glass-blur));
      -webkit-backdrop-filter: blur(var(--ghz-glass-blur));
      border: 1px solid var(--ghz-glass-border);
      border-radius: var(--ghz-radius);
      box-shadow: 0 4px 16px var(--ghz-shadow);
    }

    .glass-button {
      background: var(--ghz-glass-bg);
      backdrop-filter: blur(var(--ghz-glass-blur));
      -webkit-backdrop-filter: blur(var(--ghz-glass-blur));
      border: 1px solid var(--ghz-glass-border);
      border-radius: var(--ghz-radius);
      color: var(--ghz-text);
      cursor: pointer;
      transition: background var(--ghz-transition),
                  border-color var(--ghz-transition),
                  box-shadow var(--ghz-transition);
      outline: none;
      font-family: inherit;
      font-size: inherit;
    }

    .glass-button:hover {
      background: rgba(30, 25, 40, 0.7);
      border-color: rgba(255, 200, 120, 0.3);
    }

    .glass-button.active {
      background: rgba(232, 168, 64, 0.15);
      border-color: var(--ghz-accent);
      box-shadow: 0 0 12px rgba(232, 168, 64, 0.2);
      color: var(--ghz-accent);
    }
  `;

  /** Helper to clamp a value between min and max */
  protected clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /** Helper to linearly interpolate */
  protected lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }
}
