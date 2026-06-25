// =============================================================================
// useKeyboardInset — how many px the on-screen keyboard covers at the bottom.
//
// iOS Safari doesn't (yet) honor `interactive-widget=resizes-content`, so the
// layout viewport stays full-height when the keyboard opens and bottom-anchored
// chrome would hide behind it. We read the visualViewport instead and return
// the covered height so the Live floating controls can lift above the keyboard.
// Returns 0 on desktop / when no keyboard is shown.
// =============================================================================

import { useEffect, useState } from "react";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Layout-viewport height minus the visible area below the visual viewport.
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Ignore the small Safari toolbar collapse/expand; only treat a sizeable
      // bottom occlusion as the keyboard.
      setInset(covered > 120 ? Math.round(covered) : 0);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
