import { ChannelList } from "./ChannelList";

export function Sidebar({ onSettingsOpen, onChannelClick }: { onSettingsOpen?: () => void; onChannelClick?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-surface-secondary dark:bg-surface-dark-secondary border-r border-stone-200/60 dark:border-stone-700/40">
      {/* Logo */}
      <div className="flex items-center gap-2 px-5 py-5 border-b border-stone-200/60 dark:border-stone-700/40">
        <span className="text-xl font-bold text-stone-800 dark:text-stone-200">
          Hawky
        </span>
      </div>

      {/* Channel list */}
      <ChannelList onChannelClick={onChannelClick} />

      {/* Bottom section */}
      <div className="border-t border-stone-200/60 dark:border-stone-700/40 px-3 py-2 space-y-0.5">
        {onSettingsOpen && (
          <button
            onClick={onSettingsOpen}
            className="w-full flex items-center gap-2 px-2 py-2.5 text-sm text-muted dark:text-muted-dark hover:text-stone-700 dark:hover:text-stone-300 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
            </svg>
            Settings
          </button>
        )}
      </div>
    </div>
  );
}
