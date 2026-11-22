import { SUPPORTED_LANGUAGES } from '../shared/constants';
import type { RuntimeStatus, SubFlowSettings, SubtitleMode } from '../shared/types';

const BTN_ID = 'subflow-player-toggle-btn';
const POPOVER_HOST_ID = 'subflow-quick-popover-host';

const POPOVER_STYLES = `
:host {
  all: initial;
  position: absolute;
  right: 14px;
  bottom: 64px;
  z-index: 62;
  font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.sf-pop {
  width: 276px;
  padding: 14px;
  border-radius: 12px;
  background: #12151C;
  border: 1px solid #262C38;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.56);
  color: #F2F4F8;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sf-pop.hidden {
  display: none;
}

.sf-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sf-pop-title {
  font-size: 13px;
  font-weight: 650;
  color: #F2F4F8;
  letter-spacing: -0.01em;
}

.sf-switch {
  position: relative;
  width: 38px;
  height: 22px;
  border: none;
  border-radius: 999px;
  background: #2B3240;
  cursor: pointer;
  padding: 0;
  transition: background 150ms ease;
}

.sf-switch[aria-checked="true"] {
  background: #F5B942;
}

.sf-switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #0F1115;
  transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sf-switch[aria-checked="true"]::after {
  transform: translateX(16px);
}

.sf-switch:focus-visible,
.sf-seg-btn:focus-visible,
.sf-select:focus-visible,
.sf-action-btn:focus-visible {
  outline: 2px solid #F5B942;
  outline-offset: 2px;
}

.sf-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.sf-label {
  font-size: 11px;
  font-weight: 600;
  color: #9AA3B5;
}

.sf-seg {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: #0B0D12;
  border: 1px solid #232833;
}

.sf-seg-btn {
  border: none;
  border-radius: 6px;
  padding: 6px 4px;
  font-size: 12px;
  font-weight: 600;
  color: #9AA3B5;
  background: transparent;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.sf-seg-btn:hover {
  color: #F2F4F8;
}

.sf-seg-btn[aria-pressed="true"] {
  background: #232936;
  color: #F5B942;
}

.sf-select {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid #262C38;
  background: #0B0D12;
  color: #F2F4F8;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}

.sf-select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sf-meta {
  font-size: 11.5px;
  color: #9AA3B5;
  line-height: 1.4;
  padding-top: 2px;
  border-top: 1px solid #202531;
  font-variant-numeric: tabular-nums;
}

.sf-actions {
  display: flex;
  gap: 8px;
}

.sf-action-btn {
  flex: 1;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid #2A3140;
  background: #1A1F29;
  color: #E7ECF5;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.sf-action-btn:hover {
  background: #232A38;
  border-color: #3A4357;
}
`;

export interface PlayerControlCallbacks {
  onPatchSettings: (patch: Partial<SubFlowSettings>) => void;
  onExportSrt: () => void;
}

function createSubFlowIconSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  svg.style.margin = 'auto';

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '2.5');
  rect.setAttribute('y', '4.5');
  rect.setAttribute('width', '19');
  rect.setAttribute('height', '15');
  rect.setAttribute('rx', '3');
  rect.setAttribute('stroke', 'currentColor');
  rect.setAttribute('stroke-width', '1.75');

  const line1 = document.createElementNS(ns, 'line');
  line1.setAttribute('x1', '6.5');
  line1.setAttribute('y1', '10');
  line1.setAttribute('x2', '17.5');
  line1.setAttribute('y2', '10');
  line1.setAttribute('stroke', '#F5B942');
  line1.setAttribute('stroke-width', '2');
  line1.setAttribute('stroke-linecap', 'round');

  const line2 = document.createElementNS(ns, 'line');
  line2.setAttribute('x1', '6.5');
  line2.setAttribute('y1', '14.5');
  line2.setAttribute('x2', '14');
  line2.setAttribute('y2', '14.5');
  line2.setAttribute('stroke', 'currentColor');
  line2.setAttribute('stroke-width', '1.8');
  line2.setAttribute('stroke-linecap', 'round');

  svg.append(rect, line1, line2);
  return svg;
}

export class PlayerControl {
  private playerEl: HTMLElement | null = null;
  private buttonEl: HTMLButtonElement | null = null;
  private indicatorEl: HTMLSpanElement | null = null;
  private popoverHostEl: HTMLDivElement | null = null;
  private popoverPanelEl: HTMLDivElement | null = null;
  private switchBtnEl: HTMLButtonElement | null = null;
  private modeButtons = new Map<SubtitleMode, HTMLButtonElement>();
  private langSelectEl: HTMLSelectElement | null = null;
  private metaEl: HTMLDivElement | null = null;

  private settings: SubFlowSettings;
  private status: RuntimeStatus | null = null;
  private popoverOpen = false;
  private callbacks: PlayerControlCallbacks;

  private outsideClickHandler = (ev: MouseEvent) => {
    if (!this.popoverOpen) return;
    const path = ev.composedPath();
    if (
      (this.buttonEl && path.includes(this.buttonEl)) ||
      (this.popoverHostEl && path.includes(this.popoverHostEl))
    ) {
      return;
    }
    this.setPopoverOpen(false);
  };

  constructor(initialSettings: SubFlowSettings, callbacks: PlayerControlCallbacks) {
    this.settings = initialSettings;
    this.callbacks = callbacks;
  }

  public mount(playerEl: HTMLElement): void {
    const rightControls = playerEl.querySelector('.ytp-right-controls');
    if (!rightControls) return;

    if (this.playerEl === playerEl && this.buttonEl?.isConnected) {
      this.syncUi();
      return;
    }

    this.unmount();
    this.playerEl = playerEl;

    // Remove any stale elements from prior reloads
    playerEl.querySelector(`#${BTN_ID}`)?.remove();
    playerEl.querySelector(`#${POPOVER_HOST_ID}`)?.remove();

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'ytp-button subflow-ytp-btn';
    btn.title = 'SubFlow Smart Subtitles (Alt+S to toggle)';
    btn.setAttribute('aria-label', 'SubFlow Smart Subtitles');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.style.position = 'relative';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.verticalAlign = 'top';
    btn.style.color = '#FFFFFF';

    btn.appendChild(createSubFlowIconSvg());

    const indicator = document.createElement('span');
    indicator.style.position = 'absolute';
    indicator.style.left = '22%';
    indicator.style.right = '22%';
    indicator.style.bottom = '7px';
    indicator.style.height = '2.5px';
    indicator.style.borderRadius = '2px';
    indicator.style.background = '#F5B942';
    indicator.style.transition = 'opacity 140ms ease, transform 140ms ease';
    btn.appendChild(indicator);

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.setPopoverOpen(!this.popoverOpen);
    });

    const nativeCCBtn = rightControls.querySelector('.ytp-subtitles-button');
    if (nativeCCBtn) {
      rightControls.insertBefore(btn, nativeCCBtn);
    } else {
      rightControls.prepend(btn);
    }

    // Build inline Quick Switcher popover inside Shadow DOM
    const popHost = document.createElement('div');
    popHost.id = POPOVER_HOST_ID;
    const shadow = popHost.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = POPOVER_STYLES;
    shadow.appendChild(styleEl);

    const panel = document.createElement('div');
    panel.className = 'sf-pop hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'SubFlow quick controls');

    // Header row
    const head = document.createElement('div');
    head.className = 'sf-pop-head';
    const title = document.createElement('span');
    title.className = 'sf-pop-title';
    title.textContent = 'SubFlow Subtitles';

    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'sf-switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Enable SubFlow subtitles');
    sw.addEventListener('click', () => {
      this.callbacks.onPatchSettings({ enabled: !this.settings.enabled });
    });
    head.append(title, sw);

    // Mode segmented control
    const modeField = document.createElement('div');
    modeField.className = 'sf-field';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'sf-label';
    modeLabel.textContent = 'Display Mode';

    const seg = document.createElement('div');
    seg.className = 'sf-seg';
    const modes: Array<{ id: SubtitleMode; label: string }> = [
      { id: 'original', label: 'Original' },
      { id: 'dual', label: 'Dual' },
      { id: 'translated', label: 'Translated' },
    ];
    this.modeButtons.clear();
    for (const m of modes) {
      const mb = document.createElement('button');
      mb.type = 'button';
      mb.className = 'sf-seg-btn';
      mb.textContent = m.label;
      mb.addEventListener('click', () => {
        this.callbacks.onPatchSettings({ mode: m.id });
      });
      this.modeButtons.set(m.id, mb);
      seg.appendChild(mb);
    }
    modeField.append(modeLabel, seg);

    // Language selector
    const langField = document.createElement('div');
    langField.className = 'sf-field';
    const langLabel = document.createElement('label');
    langLabel.className = 'sf-label';
    langLabel.textContent = 'Target Language';

    const select = document.createElement('select');
    select.className = 'sf-select';
    select.setAttribute('aria-label', 'Target language');
    for (const lang of SUPPORTED_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.label} (${lang.nativeName})`;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      this.callbacks.onPatchSettings({ targetLanguage: select.value });
    });
    langField.append(langLabel, select);

    // Status metadata
    const meta = document.createElement('div');
    meta.className = 'sf-meta';
    meta.textContent = 'Ready';

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'sf-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'sf-action-btn';
    exportBtn.textContent = 'Export .SRT';
    exportBtn.addEventListener('click', () => {
      this.callbacks.onExportSrt();
    });
    actions.appendChild(exportBtn);

    panel.append(head, modeField, langField, meta, actions);
    shadow.appendChild(panel);
    playerEl.appendChild(popHost);

    this.buttonEl = btn;
    this.indicatorEl = indicator;
    this.popoverHostEl = popHost;
    this.popoverPanelEl = panel;
    this.switchBtnEl = sw;
    this.langSelectEl = select;
    this.metaEl = meta;

    document.addEventListener('click', this.outsideClickHandler, true);
    this.syncUi();
  }

  public unmount(): void {
    document.removeEventListener('click', this.outsideClickHandler, true);
    this.buttonEl?.remove();
    this.popoverHostEl?.remove();
    this.buttonEl = null;
    this.indicatorEl = null;
    this.popoverHostEl = null;
    this.popoverPanelEl = null;
    this.switchBtnEl = null;
    this.langSelectEl = null;
    this.metaEl = null;
    this.playerEl = null;
    this.popoverOpen = false;
  }

  public updateSettings(next: SubFlowSettings): void {
    this.settings = next;
    this.syncUi();
  }

  public setStatus(status: RuntimeStatus): void {
    this.status = status;
    this.syncUi();
  }

  public setPopoverOpen(open: boolean): void {
    this.popoverOpen = open;
    this.popoverPanelEl?.classList.toggle('hidden', !open);
    this.buttonEl?.setAttribute('aria-expanded', String(open));
  }

  private syncUi(): void {
    if (this.indicatorEl) {
      this.indicatorEl.style.opacity = this.settings.enabled ? '1' : '0';
      this.indicatorEl.style.transform = this.settings.enabled ? 'scaleX(1)' : 'scaleX(0.4)';
    }
    if (this.switchBtnEl) {
      this.switchBtnEl.setAttribute('aria-checked', String(this.settings.enabled));
    }
    for (const [mode, btn] of this.modeButtons.entries()) {
      btn.setAttribute('aria-pressed', String(this.settings.mode === mode));
    }
    if (this.langSelectEl) {
      this.langSelectEl.value = this.settings.targetLanguage;
      this.langSelectEl.disabled = this.settings.mode === 'original';
    }
    if (this.metaEl && this.status) {
      const engineNames: Record<SubFlowSettings['provider'], string> = {
        offline: 'Offline Merger',
        gemini: `Gemini (${this.settings.geminiModel})`,
        ollama: `Ollama (${this.settings.ollamaModel})`,
        openai: `OpenAI (${this.settings.openaiModel})`,
      };
      const engine = engineNames[this.settings.provider];
      const cuesPart = this.status.cueCount > 0 ? ` · ${this.status.cueCount} cues` : '';
      const trackPart = this.status.trackName ? ` · ${this.status.trackName}` : '';
      this.metaEl.textContent = `${engine}${trackPart}${cuesPart}`;
    }
  }
}
