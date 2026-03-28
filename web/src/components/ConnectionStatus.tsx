import { useState } from "react";
import { useSocketStore } from "../store/socket-store";

/**
 * Minimalist connection status indicator — icon only, warm tones.
 * Connected: filled WiFi icon (solid). Disconnected: outline with slash (dimmed).
 * Shows a tooltip label on hover (desktop) or tap (mobile).
 */
export function ConnectionStatus() {
  const status = useSocketStore((s) => s.status);
  const error = useSocketStore((s) => s.error);
  const [showLabel, setShowLabel] = useState(false);

  const label = status === "disconnected" && error
    ? `Disconnected: ${error}`
    : status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Reconnecting...";

  const handleTap = () => {
    setShowLabel(true);
    setTimeout(() => setShowLabel(false), 2000);
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
    >
      <button
        onClick={handleTap}
        className={`p-1.5 rounded-lg transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 ${
          status === "connected"
            ? "text-stone-700 dark:text-stone-300"
            : "text-stone-400 dark:text-stone-500"
        }`}
        aria-label={label}
        data-testid="connection-status"
      >
        {status === "connecting" || status === "reconnecting" ? (
          /* Outline WiFi, pulsing — connecting */
          <svg className="w-4 h-4 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0" />
          </svg>
        ) : status === "disconnected" ? (
          /* Outline WiFi with slash — disconnected */
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 5.636l-12.728 12.728M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01" />
          </svg>
        ) : (
          /* Filled WiFi — connected */
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" d="M1.371 8.143c5.858-5.857 15.356-5.857 21.213 0a.75.75 0 010 1.061l-.53.53a.75.75 0 01-1.06 0c-4.98-4.979-13.053-4.979-18.033 0a.75.75 0 01-1.06 0l-.53-.53a.75.75 0 010-1.06zm3.535 3.535c3.272-3.272 8.58-3.272 11.852 0a.75.75 0 010 1.061l-.53.53a.75.75 0 01-1.06 0 5.617 5.617 0 00-8.672 0 .75.75 0 01-1.06 0l-.53-.53a.75.75 0 010-1.06zm3.536 3.536a3.12 3.12 0 014.243-.001.75.75 0 01-.001 1.061l-1.59 1.59a.75.75 0 01-1.061-.001l-1.59-1.59a.75.75 0 010-1.06z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      {showLabel && (
        <div className="absolute right-0 top-full mt-1 px-2 py-1 rounded-md bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 text-xs whitespace-nowrap shadow-md z-50">
          {label}
        </div>
      )}
    </div>
  );
}
