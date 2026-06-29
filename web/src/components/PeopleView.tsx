// =============================================================================
// People View — read-only People Database viewer (web demo, #681).
//
// Web parity for the iOS "People" tab (LivePeopleDatabaseView, Cocktail Party
// #627). Reads confirmed people from the gateway person service via people.list
// and renders name / facts / last recap per person.
//
// The gateway method degrades gracefully: when the DeepFace microservice is not
// running it returns { available:false, people:[] }, and this view shows a clean
// "face database service is not running" state instead of an error — so the demo
// works in any deployment.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { useSocketStore } from "../store/socket-store";

interface Recap {
  summary: string;
  at?: string;
}

interface Person {
  id: string;
  name: string;
  facts: string[];
  recaps: Recap[];
  created_at?: string;
  last_seen_at?: string;
}

interface PeopleListResult {
  ok: true;
  available: boolean;
  people: Person[];
  note?: string;
}

function formatWhen(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function PeopleView() {
  const rpc = useSocketStore((s) => s.rpc);
  const status = useSocketStore((s) => s.status);

  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await rpc("people.list")) as PeopleListResult;
      setAvailable(result.available);
      setNote(result.note ?? null);
      setPeople(Array.isArray(result.people) ? result.people : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    if (status !== "connected") {
      setLoading(false);
      return;
    }
    void refresh();
  }, [status, refresh]);

  return (
    <div className="flex flex-col h-full bg-stone-50 dark:bg-stone-950">
      <div className="flex items-center justify-between px-6 py-3 border-b border-stone-200/60 dark:border-stone-700/40">
        <div className="text-sm text-muted dark:text-muted-dark">
          {available ? `${people.length} ${people.length === 1 ? "person" : "people"}` : "Face database offline"}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading || status !== "connected"}
          className="rounded-md border border-stone-200 dark:border-stone-700 px-3 py-1.5 text-xs text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {status !== "connected" ? (
          <EmptyState title="Not connected" body="Connect to the gateway to view the people database." />
        ) : error ? (
          <EmptyState title="Couldn’t load people" body={error} />
        ) : loading && people.length === 0 ? (
          <EmptyState title="Loading…" body="Fetching the people database." />
        ) : !available ? (
          <EmptyState
            title="Face database service is not running"
            body={
              note ??
              "Start the DeepFace service (services/deepface) or set DEEPFACE_URL to enable people recognition. The rest of the demo works without it."
            }
          />
        ) : people.length === 0 ? (
          <EmptyState
            title="No people enrolled yet"
            body="When the Live demo recognizes and enrolls someone, they’ll appear here with their facts and recaps."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-3xl mx-auto">
            {people.map((p) => (
              <PersonCard key={p.id || p.name} person={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PersonCard({ person }: { person: Person }) {
  const lastRecap = person.recaps.length > 0 ? person.recaps[person.recaps.length - 1] : null;
  const lastSeen = formatWhen(person.last_seen_at);

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-base font-medium text-stone-800 dark:text-stone-100">{person.name}</div>
        {lastSeen && <div className="text-[11px] text-muted dark:text-muted-dark">seen {lastSeen}</div>}
      </div>

      {person.facts.length > 0 && (
        <ul className="mt-3 space-y-1">
          {person.facts.map((fact, i) => (
            <li key={i} className="flex gap-2 text-sm text-stone-600 dark:text-stone-300">
              <span className="text-stone-400 dark:text-stone-600">•</span>
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      )}

      {lastRecap && (
        <div className="mt-3 rounded-lg bg-stone-50 dark:bg-stone-800/60 px-3 py-2 text-xs text-stone-600 dark:text-stone-300">
          <span className="font-medium text-stone-500 dark:text-stone-400">Last recap: </span>
          {lastRecap.summary}
        </div>
      )}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="h-full min-h-[200px] grid place-items-center text-center">
      <div className="max-w-sm">
        <div className="text-sm font-medium text-stone-700 dark:text-stone-200">{title}</div>
        <div className="mt-1 text-sm text-muted dark:text-muted-dark">{body}</div>
      </div>
    </div>
  );
}
