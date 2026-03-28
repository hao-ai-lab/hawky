// =============================================================================
// BypassPill — chat-header indicator for bypass-mode sessions.
//
// Hidden when the active session is in `default` or `accept-edits` mode.
// Shows a red/orange pill when bypass is active so the user can't easily
// forget they're auto-approving every tool call. Two variants:
//
//   - session bypass: clickable; click flips back to default mode.
//   - gateway-flag bypass (`--dangerously-skip-permissions`): non-clickable;
//     tooltip explains the gateway has to restart to disable.
//
// Backend wiring:
//   - permission.mode RPC returns `{ mode, forceBypass }`. Fetched on
//     session switch, same shape as task.list.
//   - permission.mode.changed event broadcasts on every flip — keeps
//     other tabs in step.
// =============================================================================

import { useSessionStore } from "../store/session-store";
import { useSocketStore } from "../store/socket-store";

export function BypassPill() {
  const mode = useSessionStore((s) => s.permissionMode);
  const forceBypass = useSessionStore((s) => s.forceBypass);
  const activeKey = useSessionStore((s) => s.activeKey);

  if (mode !== "bypass") return null;

  const handleClick = () => {
    if (forceBypass) return; // can't disable; gateway flag must restart
    const { rpc } = useSocketStore.getState();
    rpc("permission.mode", { mode: "default", sessionKey: activeKey }).catch(() => {});
  };

  // Color: amber-tinted to read as "warning" without screaming
  // red-on-red. Matches the rest of the header's stone-leaning palette.
  const baseClass =
    "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium " +
    "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 " +
    "border border-amber-200/70 dark:border-amber-700/40";
  const interactiveClass = forceBypass
    ? "cursor-help"
    : "cursor-pointer hover:bg-amber-100/80 dark:hover:bg-amber-900/50 transition-colors";

  const label = forceBypass ? "BYPASS (gateway flag)" : "BYPASS";
  const title = forceBypass
    ? "Gateway started with --dangerously-skip-permissions. " +
      "Restart the gateway without that flag to restore prompts."
    : "Bypass mode is on — every tool call auto-approves. Click to turn off.";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={forceBypass}
      className={`${baseClass} ${interactiveClass}`}
      aria-label={title}
      title={title}
    >
      {/* Icon: open-padlock SVG. Same outline-only style as the other
          header icons in App.tsx so the pill reads as kin to them. */}
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
