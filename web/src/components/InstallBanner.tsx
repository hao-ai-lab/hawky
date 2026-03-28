// =============================================================================
// Install Banner
//
// Shows a dismissible banner guiding iOS Safari users to "Add to Home Screen".
// Only shown when: iOS Safari + not in standalone mode + not previously dismissed.
// On Chrome/Android, the browser handles install prompts natively.
// =============================================================================

import { useState, useEffect } from "react";

const DISMISSED_KEY = "hawky-install-dismissed";

/** Check if running on iOS Safari (not Chrome/Firefox/in-app browsers on iOS) */
function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !("MSStream" in window);
  if (!isIOS) return false;
  // Exclude non-Safari iOS browsers: CriOS (Chrome), FxiOS (Firefox), EdgiOS (Edge), etc.
  return !(/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua));
}

/** Check if already in standalone mode (installed PWA) */
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true
  );
}

export function InstallBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only show on iOS Safari, not in standalone, not previously dismissed
    if (!isIOSSafari() || isStandalone()) return;
    const dismissed = localStorage.getItem(DISMISSED_KEY);
    if (dismissed) return;
    setVisible(true);
  }, []);

  const dismiss = () => {
    setVisible(false);
    localStorage.setItem(DISMISSED_KEY, "true");
  };

  if (!visible) return null;

  return (
    <div className="border-t border-stone-200/60 dark:border-stone-700/40 bg-surface dark:bg-surface-dark px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-testid="install-banner">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <span className="text-2xl shrink-0">🚀</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-stone-800 dark:text-stone-200">
            Install Hawky
          </p>
          <p className="text-xs text-muted dark:text-muted-dark">
            Tap <span className="inline-block">
              <svg className="inline w-4 h-4 align-text-bottom" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </span> Share → Add to Home Screen
          </p>
        </div>
        <button
          onClick={dismiss}
          className="text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300 p-1 shrink-0"
          aria-label="Dismiss install banner"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
