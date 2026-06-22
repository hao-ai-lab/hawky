// Web-style form primitives (not iOS pill/grouped/sheet styling): cards with a
// header, label/control rows, native-ish selects, sliders, checkboxes, inputs,
// and buttons. Used by Settings + Notifications.
import type { ReactNode } from "react";

export function Section({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h2 className="mb-2 text-sm font-semibold text-white">{title}</h2>}
      <div className="overflow-hidden rounded-lg border border-white/10 bg-paper/50 divide-y divide-white/8">{children}</div>
      {footer && <p className="mt-2 text-xs text-white/40">{footer}</p>}
    </section>
  );
}

/** A label/value row. `children` is the right-hand control. */
export function Row({ label, detail, children, onClick }: {
  label: string; detail?: string; children?: ReactNode; onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left ${onClick ? "transition-colors hover:bg-white/5" : ""}`}>
      <div className="min-w-0">
        <div className="text-sm text-white">{label}</div>
        {detail && <div className="mt-0.5 text-xs text-white/45">{detail}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </Comp>
  );
}

/** A full-width labeled field (label above, control below) — for wider inputs. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <label className="mb-1.5 block text-sm text-white">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-white/40">{hint}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  // Web-style checkbox switch.
  return (
    <label className="inline-flex cursor-pointer items-center">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span className="relative h-5 w-9 rounded-full bg-white/20 transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
        <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: readonly string[] | { value: string; label: string }[];
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-sm text-white outline-none focus:border-accent focus:ring-1 focus:ring-accent">
      {opts.map((o) => <option key={o.value} value={o.value} className="bg-canvas">{o.label}</option>)}
    </select>
  );
}

export function Slider({ value, onChange, min, max, step, suffix }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step: number; suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-32 cursor-pointer appearance-none rounded-full bg-white/20 accent-accent" />
      <span className="w-12 text-right font-mono text-xs text-white/60">{value}{suffix}</span>
    </div>
  );
}

export function TextField({ value, onChange, placeholder, type = "text", mono = false }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; mono?: boolean;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      autoCapitalize="off" autoCorrect="off" spellCheck={false}
      className={`w-56 rounded-md border border-white/15 bg-black/30 px-3 py-1.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-accent focus:ring-1 focus:ring-accent ${mono ? "font-mono" : ""}`} />
  );
}

export function TextArea({ value, onChange, placeholder, rows = 4 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
      className="w-full resize-y rounded-md border border-white/15 bg-black/30 p-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-accent focus:ring-1 focus:ring-accent" />
  );
}

export function Button({ children, onClick, tone = "primary", disabled }: {
  children: ReactNode; onClick: () => void; tone?: "primary" | "secondary" | "danger"; disabled?: boolean;
}) {
  // Standard web buttons (filled primary, outline secondary, text danger).
  const cls = tone === "primary"
    ? "bg-accent text-black hover:bg-accent/90"
    : tone === "danger"
      ? "border border-danger/40 text-danger hover:bg-danger/10"
      : "border border-white/20 text-white/80 hover:bg-white/5";
  return (
    <div className="px-4 py-3">
      <button onClick={onClick} disabled={disabled}
        className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${cls}`}>
        {children}
      </button>
    </div>
  );
}
