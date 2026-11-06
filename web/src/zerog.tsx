import { PrivyProvider, useIdentityToken, usePrivy } from "@privy-io/react-auth";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AGENT_URL, getZerogKeySource, resetZerogKey, setZerogKey, short } from "./data";
import { KV } from "./ui";

// "Sign in with 0G": the user's own 0G account (the one that holds their daily iAI credits)
// signs in through 0G's Privy app, the router turns the Privy token into a session, and the
// dashboard reads the account's credit balance. The user can then hand the buyer agent a
// capped, expiring API key on that account, so their credits pay for their agent's 0G calls.
//
// 0G shares its Privy app id with hackathon teams (it only works on localhost 3000, 3001 and
// 5173, which is why the dashboard is pinned to 5173). Without it, a 0G management key
// (mk-…, created at pc.0g.ai → Settings) does the same through the documented router API.

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const ROUTER = "https://router-api.0g.ai/v1";

interface Balance {
  address?: string;
  currency?: string;
  credit_balance?: string;
  deposit_balance?: string;
  total_balance?: string;
}

async function zg<T>(path: string, auth: string | null, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ROUTER}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `0G router ${res.status}`);
  return body;
}

/** The session token in /auth/privy's answer, wherever the router puts it (or a cookie). */
function sessionFrom(body: Record<string, unknown>): string | null {
  const data = (body.data ?? {}) as Record<string, unknown>;
  for (const v of [body.token, body.access_token, body.jwt, body.session_token, data.token, data.access_token, data.jwt]) if (typeof v === "string" && v) return v;
  return null;
}

/** 0G amounts: "0g" mode is in neuron (1e18 per 0G), "usd" mode in micro-USD. */
function credits(b: Balance, field: keyof Balance): string {
  const v = Number(b[field] ?? 0);
  return b.currency === "usd" ? `$${(v / 1e6).toFixed(4)}` : `${(v / 1e18).toFixed(6)} 0G`;
}

export function ZeroGProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={{ appearance: { theme: "dark", accentColor: "#ff951f" }, embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } } }}>
      {children}
    </PrivyProvider>
  );
}

export function ZeroGAccount() {
  return PRIVY_APP_ID ? <PrivyAccount /> : <Account mode="key" />;
}

function PrivyAccount() {
  const privy = usePrivy();
  const { identityToken } = useIdentityToken();
  const signIn = async (): Promise<string | null> => {
    // The router validates Privy tokens; try the access token, then the identity token.
    const tokens = [await privy.getAccessToken(), identityToken].filter((t): t is string => !!t);
    let last: Error | null = null;
    for (const token of tokens) {
      try {
        return sessionFrom(await zg<Record<string, unknown>>("/auth/privy", null, { method: "POST", body: JSON.stringify({ token }) }));
      } catch (err) {
        last = err as Error;
      }
    }
    throw last ?? new Error("no Privy token");
  };
  return <Account mode="privy" ready={privy.ready} authenticated={privy.authenticated} login={privy.login} logout={privy.logout} signIn={signIn} />;
}

function Account(p: { mode: "privy" | "key"; ready?: boolean; authenticated?: boolean; login?: () => void; logout?: () => Promise<void>; signIn?: () => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("kinetic.0g.auth");
    } catch {
      return null;
    }
  });
  const [connected, setConnected] = useState(false);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [agentSource, setAgentSource] = useState<"team" | "user" | null>(null);
  // The balance of the account paying for the agent, read through the agent's own key: shown when
  // this tab isn't signed in itself (e.g. another tab or device handed the agent its key).
  const [agentBalance, setAgentBalance] = useState<Balance | null>(null);
  const [mk, setMk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const remember = (token: string | null) => {
    setAuth(token);
    try {
      if (token) sessionStorage.setItem("kinetic.0g.auth", token);
      else sessionStorage.removeItem("kinetic.0g.auth");
    } catch {
      // Private mode: the session just isn't kept across reloads.
    }
  };

  const refresh = async (token: string | null) => {
    const b = await zg<Balance>("/account/balance", token);
    setBalance(b);
    setConnected(true);
    // Share the figures (not the session) with the agent this account pays for, so its other views show them.
    void fetch(`${AGENT_URL}/zerog-balance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).catch(() => {});
  };

  // Privy: once signed in, exchange the Privy token for a router session.
  useEffect(() => {
    if (p.mode !== "privy" || !p.authenticated || connected) return;
    setBusy(true);
    p.signIn!()
      .then(async (token) => {
        remember(token);
        await refresh(token);
      })
      .catch((err: Error) => setError(`0G sign-in failed: ${err.message}`))
      .finally(() => setBusy(false));
  }, [p.mode, p.authenticated]);

  useEffect(() => {
    if (p.mode === "key" && auth && !connected) refresh(auth).catch(() => remember(null));
  }, []);

  useEffect(() => {
    getZerogKeySource()
      .then((r) => setAgentSource(r.source))
      .catch(() => setAgentSource(null));
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (!connected || agentSource !== "user") return;
    const t = setInterval(() => void refresh(auth).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [connected, agentSource, auth]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = async () => {
      try {
        if (connected) await refresh(auth);
        else if (agentSource === "user") {
          const r = await fetch(`${AGENT_URL}/zerog-balance`);
          if (r.ok && alive) setAgentBalance((await r.json()) as Balance);
        }
      } catch {
        // Keep the last balance; try again.
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, connected, agentSource]);

  const connectKey = async () => {
    setBusy(true);
    setError(null);
    try {
      await refresh(mk.trim());
      remember(mk.trim());
      setMk("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A fresh API key on the user's own account, capped and expiring in a day, handed to the agent.
  const payAgent = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await zg<{ key?: string }>("/api-keys", auth, {
        method: "POST",
        body: JSON.stringify({ name: `kinetic-agent-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`, expiration: new Date(Date.now() + 24 * 3600_000).toISOString() }),
      });
      if (!created.key) throw new Error("the router didn't return a key");
      setAgentSource((await setZerogKey(created.key)).source);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    remember(null);
    setConnected(false);
    setBalance(null);
    if (agentSource === "user") setAgentSource((await resetZerogKey().catch(() => ({ source: "team" as const }))).source);
    if (p.mode === "privy") await p.logout?.();
  };

  const shown = connected ? balance : agentSource === "user" ? agentBalance : null;
  const label = shown ? `0G · ${credits(shown, "total_balance")}` : "Sign in with 0G";

  return (
    <div className="zg" ref={ref}>
      <button className="zg-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`zg-dot ${connected ? "on" : ""}`} />
        {label}
      </button>
      {open && (
        <div className="zg-pop" role="dialog" aria-label="0G account">
          <div className="hud-title">
            <span className="label">0G account</span>
            {agentSource && <span className={`tag ${agentSource === "user" ? "ok" : ""}`}>agent pays with {agentSource === "user" ? "your credits" : "team credits"}</span>}
          </div>
          {!connected && agentSource === "user" && agentBalance ? (
            <>
              <KV
                rows={[
                  ["account", agentBalance.address ? <span className="mono">{short(agentBalance.address)}</span> : "—"],
                  ["credits", credits(agentBalance, "credit_balance")],
                  ["deposit", credits(agentBalance, "deposit_balance")],
                  ["total", <b>{credits(agentBalance, "total_balance")}</b>],
                ]}
              />
              <p className="small muted" style={{ marginTop: 8 }}>
                Your agent's 0G calls and checks bill to this account.
              </p>
            </>
          ) : !connected ? (
            p.mode === "privy" ? (
              <button className="btn primary" style={{ width: "100%" }} disabled={!p.ready || busy} onClick={() => p.login?.()}>
                {busy ? "Signing in…" : "Sign in with 0G"}
              </button>
            ) : (
              <>
                <p className="small muted" style={{ marginBottom: 10 }}>
                  Paste a 0G management key (pc.0g.ai → Settings → Management Keys, scopes <code>account:read</code> and <code>keys:create</code>). It stays in this tab.
                </p>
                <div className="key-input" style={{ width: "100%" }}>
                  <input type="password" value={mk} onChange={(e) => setMk(e.target.value)} placeholder="mk-…" aria-label="0G management key" />
                  <button className="btn" disabled={!mk.trim().startsWith("mk-") || busy} onClick={connectKey}>
                    Connect
                  </button>
                </div>
              </>
            )
          ) : (
            <>
              <KV
                rows={[
                  ["account", balance?.address ? <span className="mono">{short(balance.address)}</span> : "—"],
                  ["credits", balance ? credits(balance, "credit_balance") : "—"],
                  ["deposit", balance ? credits(balance, "deposit_balance") : "—"],
                  ["total", balance ? <b>{credits(balance, "total_balance")}</b> : "—"],
                ]}
              />
              <div className="actions" style={{ marginTop: 12 }}>
                {agentSource === "user" ? (
                  <button className="btn" onClick={() => resetZerogKey().then((r) => setAgentSource(r.source))}>
                    Use team credits
                  </button>
                ) : (
                  <button className="btn primary" disabled={busy || agentSource === null} onClick={payAgent} title="Creates a 24-hour API key on your account for the buyer agent">
                    {busy ? "Creating key…" : "Pay my agent with my credits"}
                  </button>
                )}
                <button className="btn" onClick={signOut}>
                  Sign out
                </button>
              </div>
            </>
          )}
          {error && (
            <p className="small warn" style={{ marginTop: 10 }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
