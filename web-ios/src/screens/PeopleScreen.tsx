// =============================================================================
// People Screen — iOS People Database (Cocktail Party) for web-ios.
//
// Mirrors LivePeopleDatabaseView: a scrollable list of confirmed people, each row
// a 56x56 thumbnail + name + facts bullets + last recap. Pull-to-refresh maps to
// a Refresh button. Reads people.list through the gateway person service.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { useSocketStore } from "../lib/socket-store";
import { Header } from "../components/Header";

interface Recap { summary: string; at?: string }
interface Person {
  id: string; name: string; facts: string[]; recaps: Recap[];
  thumbnail?: string; last_seen_at?: string;
}
interface PeopleListResult { ok: true; available: boolean; people: Person[]; note?: string }

export function PeopleScreen() {
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
      const r = (await rpc("people.list")) as PeopleListResult;
      setAvailable(r.available);
      setNote(r.note ?? null);
      setPeople(Array.isArray(r.people) ? r.people : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    if (status !== "connected") { setLoading(false); return; }
    void refresh();
  }, [status, refresh]);

  return (
    <div className="flex h-full flex-col">
      <Header
        title="People"
        subtitle={available ? `${people.length} ${people.length === 1 ? "person" : "people"}` : undefined}
        action={{ label: loading ? "…" : "Refresh", onClick: () => void refresh(), disabled: status !== "connected" }}
      />
      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-4 md:px-6 md:pb-6">
        {status !== "connected" ? (
          <Empty title="Not connected" body="Connect to the gateway to view the people database." />
        ) : error ? (
          <Empty title="Couldn’t load people" body={error} />
        ) : loading && people.length === 0 ? (
          <Empty title="Loading…" body="Fetching the people database." />
        ) : !available ? (
          <Empty title="Face database not running"
            body={note ?? "Start the DeepFace service (services/deepface) or set DEEPFACE_URL. The rest of the app works without it."} />
        ) : people.length === 0 ? (
          <Empty title="No people yet"
            body="When Live recognizes and enrolls someone, they’ll appear here with their facts and recaps." />
        ) : (
          <ul className="mx-auto grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {people.map((p) => <PersonRow key={p.id || p.name} person={p} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function PersonRow({ person }: { person: Person }) {
  const recap = person.recaps.length ? person.recaps[person.recaps.length - 1] : null;
  const initials = person.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <li className="flex gap-3 rounded-card bg-paper p-4">
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-pill bg-white/10">
        {person.thumbnail ? (
          <img src={`data:image/jpeg;base64,${person.thumbnail}`} alt={person.name} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-sm font-semibold text-accent">{initials || "?"}</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-white">{person.name}</div>
        {person.facts.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {person.facts.slice(0, 4).map((f, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-white/70"><span className="text-white/30">•</span><span>{f}</span></li>
            ))}
          </ul>
        )}
        {recap && <div className="mt-1.5 text-xs italic text-white/45">“{recap.summary}”</div>}
      </div>
    </li>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-full min-h-[240px] place-items-center text-center">
      <div className="max-w-xs">
        <div className="text-base font-semibold text-white">{title}</div>
        <div className="mt-1 text-sm text-white/55">{body}</div>
      </div>
    </div>
  );
}
