// Content-area screen header for the responsive web layout (full-width, not
// constrained to a phone width). Optional trailing action button.
export function Header({ title, subtitle, action }: {
  title: string;
  subtitle?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 md:px-6">
      <div>
        <h1 className="text-base font-semibold text-white md:text-lg">{title}</h1>
        {subtitle && <p className="text-xs text-white/50">{subtitle}</p>}
      </div>
      {action && (
        <button onClick={action.onClick} disabled={action.disabled}
          className="pressable rounded-pill px-3 py-1.5 text-sm font-medium text-accent disabled:opacity-40">
          {action.label}
        </button>
      )}
    </header>
  );
}
