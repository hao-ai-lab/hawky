// =============================================================================
// SlashMenu — autocomplete dropdown for `/command` invocations.
//
// Shown anchored to the chat input whenever the input starts with `/` and
// has no leading whitespace before the slash. The user can:
//   - arrow up/down to navigate
//   - tab or enter to autocomplete the highlighted command (just the name —
//     the menu stays open so the user can add args)
//   - escape to dismiss
//   - click a row to autocomplete it
//
// Selection is owned by the parent (InputBar) so keyboard handling lives
// alongside the existing Enter/up/down logic.
// =============================================================================

import { useEffect, useRef } from "react";
import type { SlashCommand } from "../lib/slash-commands.js";

export interface SlashMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({ commands, selectedIndex, onSelect, onHover }: SlashMenuProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);

  // Keep the selected row scrolled into view as the user arrows through.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900"
      data-testid="slash-menu"
    >
      {commands.map((cmd, i) => {
        const selected = i === selectedIndex;
        const usage = `/${cmd.name}${cmd.args ? " " + cmd.args : ""}`;
        return (
          <button
            key={cmd.name}
            ref={selected ? selectedRowRef : undefined}
            role="option"
            aria-selected={selected}
            onClick={(e) => { e.preventDefault(); onSelect(cmd); }}
            onMouseEnter={() => onHover(i)}
            className={`block w-full text-left px-3 py-2 transition-colors ${
              selected
                ? "bg-stone-100 dark:bg-stone-800"
                : "hover:bg-stone-50 dark:hover:bg-stone-800/50"
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-sm text-stone-800 dark:text-stone-200">
                {usage}
              </span>
              <span className="text-xs text-stone-500 dark:text-stone-400 truncate">
                {cmd.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
