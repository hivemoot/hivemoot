"use client";

import { useEffect, useState } from "react";
import { GITHUB_LOGIN_RE, REMEMBERED_USER_COOKIE } from "@/constants/cookies";
import { getCookie } from "@/lib/cookies";
import { fetchSessionStatus, resolveNavState, type NavState } from "./auth-nav-helpers";

/**
 * Single source of truth for auth-aware navigation.
 *
 * Hydration: initial state is `loading` on both server and client (no cookie
 * read during render), so SSR and first client render match. After mount it
 * reads the remembered-user hint (instant) and probes /api/auth/session
 * (authoritative), then resolves to authenticated / remembered / anonymous.
 */
export function useSessionStatus(): NavState {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [hasInstallation, setHasInstallation] = useState(false);
  const [remembered, setRemembered] = useState<string | null>(null);

  useEffect(() => {
    const raw = getCookie(REMEMBERED_USER_COOKIE);
    if (raw && GITHUB_LOGIN_RE.test(raw)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only init after hydration
      setRemembered(raw);
    }

    let cancelled = false;
    fetchSessionStatus()
      .then((status) => {
        if (cancelled) return;
        setAuthenticated(status.authenticated);
        setLogin(status.login);
        setHasInstallation(status.hasInstallation);
      })
      .catch(() => {
        // Treat any failure as anonymous; the remembered hint still applies.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return resolveNavState({ loading, authenticated, login, hasInstallation, remembered });
}
