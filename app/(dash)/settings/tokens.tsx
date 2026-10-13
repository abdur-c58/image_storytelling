"use client";

import { useState, useTransition } from "react";
import { createTokenAction, revokeTokenAction } from "@/app/actions";

interface TokenView {
  id: string;
  name: string;
  role: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function TokenManager({ tokens }: { tokens: TokenView[] }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<"bot" | "worker">("bot");
  const [created, setCreated] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="card flex flex-col gap-4 text-sm">
      <h2 className="eyebrow">API tokens</h2>
      <p className="font-light text-muted">
        Tokens are stored hashed; the full value is shown once. Rotate by creating a new token, switching the client to it,
        then revoking the old one.
      </p>
      <div className="flex flex-wrap gap-2">
        <input className="input" placeholder="Name (e.g. grok-bot)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as "bot" | "worker")}>
          <option value="bot">bot</option>
          <option value="worker">worker</option>
        </select>
        <button
          className="btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await createTokenAction(name, role);
              setCreated(res.token);
              setName("");
            })
          }
        >
          Create token
        </button>
      </div>
      {created && (
        <div className="rounded-xl border border-warn/40 p-3">
          <p className="mb-1 text-warn">Copy this now; it will not be shown again.</p>
          <code className="break-all font-mono text-xs">{created}</code>
        </div>
      )}
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1">Name</th>
            <th>Role</th>
            <th>Prefix</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} className={`border-t border-line ${t.revokedAt ? "text-muted line-through" : ""}`}>
              <td className="py-1">{t.name}</td>
              <td>{t.role}</td>
              <td className="font-mono">{t.prefix}…</td>
              <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}</td>
              <td>
                {!t.revokedAt && (
                  <button
                    className="btn px-3 py-0.5 text-xs"
                    onClick={() => {
                      if (window.confirm(`Revoke "${t.name}"? Clients using it stop working immediately.`)) {
                        start(() => revokeTokenAction(t.id));
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
