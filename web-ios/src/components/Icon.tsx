// Minimal icon set approximating the SF Symbols used by the iOS app.
// Stroke-based, currentColor — sized via className (w-/h-).

type IconName =
  | "live" | "people" | "settings"
  | "chat" | "memory" | "recordings" | "bell"
  | "mic" | "micOff" | "video" | "videoOff"
  | "ear" | "earFill" | "person2" | "person2Fill"
  | "phone" | "stop" | "play"
  | "send" | "more" | "brain" | "flip" | "chevronDown" | "chevronRight" | "chevronLeft" | "sidebar"
  | "checkmark" | "xmark" | "antenna" | "warning" | "plus" | "minus" | "trash" | "pin" | "refresh" | "chart";

const PATHS: Record<IconName, React.ReactNode> = {
  // "Live" — broadcast signal: a center dot with radiating arcs (distinct from
  // the camera/video icon).
  live: <><circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 010 8.49M7.76 16.24a6 6 0 010-8.49M19.07 4.93a10 10 0 010 14.14M4.93 19.07a10 10 0 010-14.14" /></>,
  people: <path d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />,
  settings: <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
  mic: <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />,
  micOff: <><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" /><path d="M19 10v2a7 7 0 01-.11 1.23M12 19v4M8 23h8M2 2l20 20" /></>,
  video: <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />,
  videoOff: <><path d="M16 16v2a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h2m4 0h3a2 2 0 012 2v2M21 8.6v6.764a1 1 0 01-1.447.894L15 14" /><path d="M2 2l20 20" /></>,
  ear: <path d="M6 8.5a6 6 0 1112 0c0 2-1 3-2 4s-2 1.5-2 3a2.5 2.5 0 01-5 0M9 9a3 3 0 016 0" />,
  earFill: <path d="M6 8.5a6 6 0 1112 0c0 2-1 3-2 4s-2 1.5-2 3a2.5 2.5 0 01-5 0M9 9a3 3 0 016 0" />,
  person2: <path d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zM16 7a4 4 0 010 8" />,
  person2Fill: <path d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zM16 7a4 4 0 010 8" />,
  phone: <path d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11 11 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  play: <path d="M5 3l14 9-14 9V3z" />,
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  more: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
  brain: <path d="M9.5 2A2.5 2.5 0 007 4.5v.5a2.5 2.5 0 000 5 2.5 2.5 0 002.5 2.5M9.5 2a2.5 2.5 0 015 0M14.5 2A2.5 2.5 0 0117 4.5v.5a2.5 2.5 0 010 5 2.5 2.5 0 01-2.5 2.5M12 4.5v15a2.5 2.5 0 005 0" />,
  flip: <path d="M3 7v6h6M21 17v-6h-6M21 7a9 9 0 00-15-3M3 17a9 9 0 0015 3" />,
  chevronDown: <path d="M19 9l-7 7-7-7" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
  checkmark: <path d="M5 13l4 4L19 7" />,
  xmark: <path d="M6 6l12 12M18 6L6 18" />,
  antenna: <path d="M5 12a7 7 0 0114 0M8.5 12a3.5 3.5 0 017 0M12 12v9" />,
  warning: <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />,
  chat: <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />,
  memory: <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0H5a2 2 0 01-2-2v-4m6 6h10a2 2 0 002-2v-4M3 9h18M3 15h18" />,
  recordings: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /></>,
  bell: <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: <path d="M3 6h18M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />,
  pin: <path d="M12 17v5M9 10.76V4a1 1 0 011-1h4a1 1 0 011 1v6.76l2 3.24H7l2-3.24z" />,
  refresh: <path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5" />,
  chevronLeft: <path d="M15 19l-7-7 7-7" />,
  // Sidebar/panel toggle: a rounded rectangle with a left rail.
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  // Bar chart: axes + three bars.
  chart: <><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" /><rect x="12" y="8" width="3" height="10" /><rect x="17" y="5" width="3" height="13" /></>,
};

export function Icon({ name, className = "w-6 h-6", filled = false }: { name: IconName; className?: string; filled?: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export type { IconName };
