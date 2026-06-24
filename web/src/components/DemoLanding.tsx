// =============================================================================
// Demo Landing — feature tour for the hosted web demo (#681).
//
// A purely presentational panel shown when the user opens the demo area. It
// summarizes what the browser demo can do, notes the camera/mic permission and
// BYOK-key requirements, and links into each demo view. It also states plainly
// which iOS features are out of scope in the browser (glasses, native Safety
// vision) so "all features" stays honest.
// =============================================================================

interface DemoLandingProps {
  onStartLive: () => void;
  onOpenTranscription: () => void;
  onOpenPeople: () => void;
  onOpenSettings: () => void;
}

interface Feature {
  title: string;
  body: string;
  cta: string;
  onClick: (p: DemoLandingProps) => void;
}

const FEATURES: Feature[] = [
  {
    title: "Live",
    body: "Full realtime voice + camera. Talk naturally; the agent sees your camera and can delegate durable work to the backend.",
    cta: "Start Live",
    onClick: (p) => p.onStartLive(),
  },
  {
    title: "Transcription",
    body: "Stream your microphone and watch an accurate, timestamped transcript appear in real time.",
    cta: "Open Transcription",
    onClick: (p) => p.onOpenTranscription(),
  },
  {
    title: "People",
    body: "Browse the face-recognition people database — names, learned facts, and last recaps (Cocktail Party).",
    cta: "Open People",
    onClick: (p) => p.onOpenPeople(),
  },
];

export function DemoLanding(props: DemoLandingProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-stone-50 dark:bg-stone-950">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-serif text-stone-800 dark:text-stone-100">Hawky Web Demo</h1>
        <p className="mt-2 text-sm text-muted dark:text-muted-dark">
          Try the assistant right in your browser — no install. Chat is always
          available in the sidebar; the demos below mirror the iOS app.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex flex-col rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
              <div className="text-base font-medium text-stone-800 dark:text-stone-100">{f.title}</div>
              <p className="mt-1 flex-1 text-sm text-stone-600 dark:text-stone-300">{f.body}</p>
              <button
                onClick={() => f.onClick(props)}
                className="mt-3 self-start rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900"
              >
                {f.cta}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
          <div className="text-sm font-medium text-stone-800 dark:text-stone-100">Before you start</div>
          <ul className="mt-2 space-y-1.5 text-sm text-stone-600 dark:text-stone-300">
            <li>• Live and Transcription request <strong>camera/microphone</strong> permission (a secure <code className="font-mono text-[11px]">https://</code> origin is required).</li>
            <li>
              • Add your own OpenAI key in{" "}
              <button onClick={props.onOpenSettings} className="underline hover:text-stone-800 dark:hover:text-stone-100">Settings</button>{" "}
              to power the realtime demos. It stays in this browser only.
            </li>
          </ul>
        </div>

        <p className="mt-6 text-xs text-muted dark:text-muted-dark">
          iPhone-only features not available in the browser: smart-glasses capture
          and the native Safety-vision watch. Everything else is here.
        </p>
      </div>
    </div>
  );
}
