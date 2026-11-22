import type { RuntimeStatus, SubFlowSettings, SubtitleCue } from '../shared/types';

const OVERLAY_HOST_ID = 'subflow-overlay-root';
const HIDE_NATIVE_STYLE_ID = 'subflow-hide-native-captions-style';

const OVERLAY_STYLES = `
:host {
  all: initial;
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 42;
  font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

.sf-stage {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--sf-bottom, 9%);
  width: min(86%, 980px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transition: bottom 220ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
}

.sf-stage.controls-visible {
  bottom: max(var(--sf-bottom, 9%), 68px);
}

.sf-stage.dragging {
  transition: none;
}

.sf-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(15, 17, 21, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.11);
  color: #D9DFEB;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.38);
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 180ms ease-out, transform 180ms ease-out;
  pointer-events: none;
  max-width: 90%;
  text-align: center;
}

.sf-status-chip.visible {
  opacity: 1;
  transform: translateY(0);
}

.sf-status-chip.is-error {
  border-color: rgba(242, 108, 108, 0.45);
  color: #FFD5D5;
}

.sf-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #F5B942;
  flex-shrink: 0;
}

.sf-status-chip.is-processing .sf-dot {
  animation: sf-pulse 1.2s ease-in-out infinite;
}

.sf-status-chip.is-error .sf-dot {
  background: #F26C6C;
}

@keyframes sf-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.88); }
  50% { opacity: 1; transform: scale(1.1); }
}

.sf-cue-box {
  pointer-events: auto;
  cursor: grab;
  max-width: 100%;
  padding: 10px 18px 11px;
  border-radius: 10px;
  background: rgba(13, 16, 22, var(--sf-bg-opacity, 0.78));
  border: 1px solid rgba(255, 255, 255, calc(var(--sf-bg-opacity, 0.78) * 0.11));
  box-shadow: 0 8px 28px rgba(0, 0, 0, calc(var(--sf-bg-opacity, 0.78) * 0.48));
  backdrop-filter: blur(var(--sf-blur, 6px));
  -webkit-backdrop-filter: blur(var(--sf-blur, 6px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 110ms ease-out, transform 130ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms ease;
}

.sf-cue-box.has-content {
  opacity: 1;
  transform: translateY(0);
}

.sf-cue-box:hover {
  border-color: rgba(245, 185, 66, 0.42);
}

.sf-cue-box:active {
  cursor: grabbing;
}

.sf-line {
  margin: 0;
  padding: 0;
  line-height: 1.38;
  text-wrap: balance;
  word-break: break-word;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.92),
    0 2px 8px rgba(0, 0, 0, 0.7);
}

.sf-line-primary {
  font-size: var(--sf-font-size, 22px);
  font-weight: 600;
  color: #F6F7FA;
  letter-spacing: -0.005em;
}

.sf-line-secondary {
  font-size: calc(var(--sf-font-size, 22px) * 0.85);
  font-weight: 500;
  color: #F8D589;
  letter-spacing: 0.002em;
}

.sf-cue-box.single-line .sf-line-primary {
  color: #F6F7FA;
}

.sf-hidden {
  display: none !important;
}
`;

export class SubtitleOverlay {
  private playerEl: HTMLElement | null = null;
  private hostEl: HTMLDivElement | null = null;
  private stageEl: HTMLDivElement | null = null;
  private statusChipEl: HTMLDivElement | null = null;
  private statusTextEl: HTMLSpanElement | null = null;
  private cueBoxEl: HTMLDivElement | null = null;
  private primaryLineEl: HTMLParagraphElement | null = null;
  private secondaryLineEl: HTMLParagraphElement | null = null;

  private settings: SubFlowSettings;
  private currentCue: SubtitleCue | null = null;
  private currentStatus: RuntimeStatus | null = null;
  private controlsObserver: MutationObserver | null = null;
  private pausedByHover = false;
  private onPositionCommit?: (bottomOffsetPercent: number) => void;

  private dragActive = false;
  private dragStartY = 0;
  private dragStartBottomPx = 0;

  constructor(
    initialSettings: SubFlowSettings,
    onPositionCommit?: (bottomOffsetPercent: number) => void,
  ) {
    this.settings = initialSettings;
    this.onPositionCommit = onPositionCommit;
  }

  public mount(playerEl: HTMLElement): void {
    if (this.playerEl === playerEl && this.hostEl?.isConnected) {
      this.applyStyles();
      this.syncNativeCaptionVisibility();
      return;
    }

    this.unmount();
    this.playerEl = playerEl;

    const existing = playerEl.querySelector(`#${OVERLAY_HOST_ID}`);
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    host.setAttribute('data-subflow-overlay', 'true');
    const shadow = host.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_STYLES;
    shadow.appendChild(styleEl);

    const stage = document.createElement('div');
    stage.className = 'sf-stage';

    const statusChip = document.createElement('div');
    statusChip.className = 'sf-status-chip';
    statusChip.setAttribute('role', 'status');
    statusChip.setAttribute('aria-live', 'polite');

    const dot = document.createElement('span');
    dot.className = 'sf-dot';
    const statusText = document.createElement('span');
    statusChip.append(dot, statusText);

    const cueBox = document.createElement('div');
    cueBox.className = 'sf-cue-box sf-hidden';
    cueBox.title = 'Drag vertically to adjust subtitle height';

    const primaryLine = document.createElement('p');
    primaryLine.className = 'sf-line sf-line-primary';

    const secondaryLine = document.createElement('p');
    secondaryLine.className = 'sf-line sf-line-secondary sf-hidden';

    cueBox.append(primaryLine, secondaryLine);
    stage.append(statusChip, cueBox);
    shadow.appendChild(stage);

    playerEl.appendChild(host);

    this.hostEl = host;
    this.stageEl = stage;
    this.statusChipEl = statusChip;
    this.statusTextEl = statusText;
    this.cueBoxEl = cueBox;
    this.primaryLineEl = primaryLine;
    this.secondaryLineEl = secondaryLine;

    this.bindInteractions(cueBox);
    this.observeYouTubeControls(playerEl);
    this.applyStyles();
    this.syncNativeCaptionVisibility();
    this.renderCue();
    this.renderStatus();
  }

  public unmount(): void {
    this.controlsObserver?.disconnect();
    this.controlsObserver = null;
    this.hostEl?.remove();
    this.hostEl = null;
    this.stageEl = null;
    this.statusChipEl = null;
    this.statusTextEl = null;
    this.cueBoxEl = null;
    this.primaryLineEl = null;
    this.secondaryLineEl = null;
    this.playerEl = null;
  }

  public updateSettings(next: SubFlowSettings): void {
    this.settings = next;
    this.applyStyles();
    this.syncNativeCaptionVisibility();
    this.renderCue();
    this.renderStatus();
  }

  public setCue(cue: SubtitleCue | null): void {
    const prev = this.currentCue;
    if (
      prev?.id === cue?.id &&
      prev?.original === cue?.original &&
      prev?.translated === cue?.translated
    ) {
      return;
    }
    this.currentCue = cue;
    this.renderCue();
  }

  public setStatus(status: RuntimeStatus): void {
    this.currentStatus = status;
    this.renderStatus();
  }

  private applyStyles(): void {
    if (!this.hostEl) return;
    const isFullscreen =
      Boolean(document.fullscreenElement) ||
      Boolean(this.playerEl?.classList.contains('ytp-fullscreen'));
    const scaledFont = isFullscreen
      ? Math.round(this.settings.fontSize * 1.24)
      : this.settings.fontSize;

    this.hostEl.style.setProperty('--sf-font-size', `${scaledFont}px`);
    this.hostEl.style.setProperty('--sf-bg-opacity', String(this.settings.bgOpacity));
    this.hostEl.style.setProperty('--sf-blur', this.settings.bgOpacity > 0.12 ? '6px' : '0px');
    this.hostEl.style.setProperty('--sf-bottom', `${this.settings.bottomOffsetPercent}%`);

    if (this.stageEl) {
      this.stageEl.classList.toggle('sf-hidden', !this.settings.enabled);
    }
  }

  private syncNativeCaptionVisibility(): void {
    const shouldHide = this.settings.enabled && this.settings.hideNativeCaptions;
    let styleEl = document.getElementById(HIDE_NATIVE_STYLE_ID) as HTMLStyleElement | null;

    if (shouldHide) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = HIDE_NATIVE_STYLE_ID;
        styleEl.textContent =
          '.html5-video-player .ytp-caption-window-container { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }';
        (document.head || document.documentElement).appendChild(styleEl);
      }
    } else if (styleEl) {
      styleEl.remove();
    }
  }

  private renderCue(): void {
    if (!this.cueBoxEl || !this.primaryLineEl || !this.secondaryLineEl) return;

    if (!this.settings.enabled || !this.currentCue) {
      this.cueBoxEl.classList.remove('has-content');
      this.cueBoxEl.classList.add('sf-hidden');
      this.primaryLineEl.textContent = '';
      this.secondaryLineEl.textContent = '';
      return;
    }

    const cue = this.currentCue;
    let primary = '';
    let secondary = '';

    if (this.settings.mode === 'original') {
      primary = cue.original;
    } else if (this.settings.mode === 'translated') {
      primary = cue.translated || cue.original;
    } else {
      // dual mode
      if (cue.translated && cue.translated.trim() && cue.translated !== cue.original) {
        if (this.settings.dualOrder === 'translated-top') {
          primary = cue.translated;
          secondary = cue.original;
        } else {
          primary = cue.original;
          secondary = cue.translated;
        }
      } else {
        primary = cue.original;
      }
    }

    if (!primary.trim()) {
      this.cueBoxEl.classList.remove('has-content');
      this.cueBoxEl.classList.add('sf-hidden');
      return;
    }

    this.primaryLineEl.textContent = primary;
    if (secondary.trim()) {
      this.secondaryLineEl.textContent = secondary;
      this.secondaryLineEl.classList.remove('sf-hidden');
      this.cueBoxEl.classList.remove('single-line');
    } else {
      this.secondaryLineEl.textContent = '';
      this.secondaryLineEl.classList.add('sf-hidden');
      this.cueBoxEl.classList.add('single-line');
    }

    this.cueBoxEl.classList.remove('sf-hidden');
    this.cueBoxEl.classList.add('has-content');
  }

  private renderStatus(): void {
    if (!this.statusChipEl || !this.statusTextEl) return;

    const st = this.currentStatus;
    if (!this.settings.enabled || !st) {
      this.statusChipEl.classList.remove('visible', 'is-processing', 'is-error');
      return;
    }

    this.statusChipEl.classList.remove('is-processing', 'is-error');

    if (st.state === 'loading') {
      this.statusTextEl.textContent = 'SubFlow: Loading transcript...';
      this.statusChipEl.classList.add('visible', 'is-processing');
      return;
    }

    if (st.state === 'processing') {
      const progress =
        st.totalChunks > 0 ? ` (${st.processedChunks}/${st.totalChunks})` : '';
      const label =
        st.mode === 'original' ? 'AI refining sentences' : 'AI translating context';
      this.statusTextEl.textContent = `${label}${progress}`;
      this.statusChipEl.classList.add('visible', 'is-processing');
      return;
    }

    if (st.state === 'error' && st.message) {
      this.statusTextEl.textContent = st.message;
      this.statusChipEl.classList.add('visible', 'is-error');
      return;
    }

    if (st.state === 'ready' && st.message) {
      // Helpful non-error note (e.g., dual mode selected while offline provider is active)
      this.statusTextEl.textContent = st.message;
      this.statusChipEl.classList.add('visible');
      return;
    }

    this.statusChipEl.classList.remove('visible');
  }

  private observeYouTubeControls(playerEl: HTMLElement): void {
    const sync = () => {
      if (!this.stageEl) return;
      const hidden = playerEl.classList.contains('ytp-autohide');
      this.stageEl.classList.toggle('controls-visible', !hidden);
      this.applyStyles();
    };

    sync();
    this.controlsObserver = new MutationObserver(sync);
    this.controlsObserver.observe(playerEl, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private bindInteractions(cueBox: HTMLDivElement): void {
    // Hover-to-pause for language study
    cueBox.addEventListener('pointerenter', () => {
      if (!this.settings.pauseOnHover || !this.playerEl) return;
      const video = this.playerEl.querySelector('video');
      if (video && !video.paused) {
        video.pause();
        this.pausedByHover = true;
      }
    });

    cueBox.addEventListener('pointerleave', () => {
      if (!this.pausedByHover || !this.playerEl) return;
      const video = this.playerEl.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }
      this.pausedByHover = false;
    });

    // Vertical drag to reposition subtitles
    cueBox.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0 || !this.playerEl || !this.stageEl) return;
      ev.stopPropagation();
      this.dragActive = true;
      this.dragStartY = ev.clientY;
      const playerRect = this.playerEl.getBoundingClientRect();
      this.dragStartBottomPx = (this.settings.bottomOffsetPercent / 100) * playerRect.height;
      this.stageEl.classList.add('dragging');
      cueBox.setPointerCapture(ev.pointerId);
    });

    cueBox.addEventListener('pointermove', (ev: PointerEvent) => {
      if (!this.dragActive || !this.playerEl || !this.hostEl) return;
      const playerRect = this.playerEl.getBoundingClientRect();
      if (playerRect.height <= 0) return;
      const deltaY = this.dragStartY - ev.clientY;
      const nextBottomPx = this.dragStartBottomPx + deltaY;
      const nextPct = Math.round(
        Math.min(78, Math.max(4, (nextBottomPx / playerRect.height) * 100)),
      );
      this.settings = { ...this.settings, bottomOffsetPercent: nextPct };
      this.hostEl.style.setProperty('--sf-bottom', `${nextPct}%`);
    });

    const endDrag = (ev: PointerEvent) => {
      if (!this.dragActive) return;
      this.dragActive = false;
      this.stageEl?.classList.remove('dragging');
      if (cueBox.hasPointerCapture(ev.pointerId)) {
        cueBox.releasePointerCapture(ev.pointerId);
      }
      this.onPositionCommit?.(this.settings.bottomOffsetPercent);
    };

    cueBox.addEventListener('pointerup', endDrag);
    cueBox.addEventListener('pointercancel', endDrag);
  }
}
