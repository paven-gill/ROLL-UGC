"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { createBrowserAuthClient } from "@/lib/supabase";
import { setApiCampaign } from "@/lib/api";

export interface Campaign {
  id: string;
  name: string;
  slug: string | null;
}

interface Me {
  userId: string;
  email: string | null;
  role: "super_admin" | "brand_admin";
  isSuperAdmin: boolean;
  campaigns: Campaign[];
}

interface AuthState extends Me {
  /** Active campaign id; null = "all campaigns" (super_admin only). */
  activeCampaignId: string | null;
  setActiveCampaign: (id: string | null) => void;
  /**
   * Re-read the campaign list from the server. Call after adding, renaming, or
   * deleting a campaign on the Manage page — otherwise the campaign picker keeps
   * showing the list as it was when the app first loaded (a deleted brand stays
   * selectable, a new one is missing) until a full page reload.
   */
  refreshCampaigns: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const STORAGE_KEY = "ugc.activeCampaignId";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const [me, setMe] = useState<Me | null>(null);
  const [activeCampaignId, setActiveCampaignIdState] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Me | null) => {
        if (!data) {
          router.push("/login");
          return;
        }
        setMe(data);
        if (data.isSuperAdmin) {
          // restore last selection if still valid, else "all"
          const saved =
            typeof window !== "undefined"
              ? window.localStorage.getItem(STORAGE_KEY)
              : null;
          const valid = saved && data.campaigns.some((c) => c.id === saved);
          setActiveCampaignIdState(valid ? saved : null);
        } else {
          // brand_admin: locked to their one campaign
          setActiveCampaignIdState(data.campaigns[0]?.id ?? null);
        }
      })
      .finally(() => setLoaded(true));
  }, [router, isLoginPage]);

  const setActiveCampaign = useCallback(
    (id: string | null) => {
      setActiveCampaignIdState(id);
      if (typeof window !== "undefined") {
        if (id) window.localStorage.setItem(STORAGE_KEY, id);
        else window.localStorage.removeItem(STORAGE_KEY);
      }
    },
    []
  );

  // Pull a fresh campaign list. If the campaign currently being viewed no longer
  // exists (you just deleted the brand you were looking at), drop back to "All
  // campaigns" and clear the saved selection so it can't be restored later.
  const refreshCampaigns = useCallback(async () => {
    const res = await fetch("/api/me");
    if (!res.ok) return;
    const data: Me | null = await res.json();
    if (!data) return;
    setMe(data);
    setActiveCampaignIdState((current) => {
      if (current && !data.campaigns.some((c) => c.id === current)) {
        if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return current;
    });
  }, []);

  const logout = useCallback(async () => {
    await createBrowserAuthClient().auth.signOut();
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    router.push("/login");
    router.refresh();
  }, [router]);

  // The login page renders without auth gating.
  if (isLoginPage) return <>{children}</>;

  // Keep the apiFetch header in sync before children render/fetch.
  setApiCampaign(activeCampaignId);

  if (!loaded || !me) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-400">
        Loading…
      </div>
    );
  }

  return (
    <Ctx.Provider
      value={{ ...me, activeCampaignId, setActiveCampaign, refreshCampaigns, logout }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
