"use client";

import { useState, useTransition } from "react";
import { saveVoiceSettingsAction } from "@/app/actions";

interface ChannelVoiceView {
  id: string;
  name: string;
  /** voice_id from the character's JSON definition ("" = none). */
  jsonVoiceId: string;
  canSpeak: boolean;
}

export function VoiceSettingsForm({
  defaultVoiceId,
  channelVoices,
  cast,
}: {
  defaultVoiceId: string;
  channelVoices: Record<string, string>;
  cast: ChannelVoiceView[];
}) {
  const [narrator, setNarrator] = useState(defaultVoiceId);
  const [channel, setChannel] = useState<Record<string, string>>(channelVoices);
  const [message, setMessage] = useState<{ tone: string; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const res = await saveVoiceSettingsAction({ default_voice_id: narrator, channel });
      setMessage(res.error ? { tone: "text-bad", text: res.error } : { tone: "text-ok", text: "Saved. New voice tasks use these ids." });
    });
  return (
    <section className="card flex flex-col gap-4 text-sm">
      <h2 className="eyebrow">Voices</h2>
      <p className="font-light text-muted">
        Fish Audio voice ids used for voicing, so changing a voice needs no JSON, code or env edit. Order of priority: a
        voice set on the Story page, then a channel character&apos;s voice below, then the story JSON, then the default
        voice below, then the worker&apos;s <code className="text-xs">FISH_VOICE_ID</code>. Changes apply to voice tasks
        and voice tests from now on; regenerate a project&apos;s voice to hear them in an existing episode.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Default voice id (narrator, and any speaker without one)</span>
        <input
          className="input font-mono"
          placeholder="e.g. 8ef4a238714b45718ce04243307c57a7"
          value={narrator}
          onChange={(e) => setNarrator(e.target.value)}
        />
      </label>
      {cast.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted">Channel cast (applies in every story that uses the character)</span>
          {cast.map((c) => (
            <label key={c.id} className="grid grid-cols-[10rem_1fr] items-center gap-2">
              <span>
                {c.name} <span className="font-mono text-xs text-muted">{c.id}</span>
              </span>
              <input
                className="input font-mono"
                disabled={!c.canSpeak}
                placeholder={c.canSpeak ? c.jsonVoiceId || "from the story JSON" : "no voice in the JSON (can't speak)"}
                value={channel[c.id] ?? ""}
                onChange={(e) => setChannel((prev) => ({ ...prev, [c.id]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save voices"}
        </button>
        {message && <span className={`text-xs ${message.tone}`}>{message.text}</span>}
      </div>
    </section>
  );
}
