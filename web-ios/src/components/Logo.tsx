// The Hawk brand mark: the iOS app's owl icon + wordmark.
export function Logo({ size = 24, showText = true, textClass = "" }: {
  size?: number; showText?: boolean; textClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <img
        src="/hawk-icon.png"
        alt="Hawk"
        width={size}
        height={size}
        className="rounded-[6px] object-cover"
        style={{ width: size, height: size }}
      />
      {showText && <span className={`font-semibold tracking-tight ${textClass}`}>Hawk</span>}
    </span>
  );
}
