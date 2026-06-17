import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

// Lazy browser client — deferred so Next.js build-time module evaluation
// doesn't throw when env vars aren't available during static analysis.
let _browserClient: SupabaseClient | undefined;
export function getSupabase(): SupabaseClient {
  if (!_browserClient) {
    _browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return _browserClient;
}

// Keep backward-compat export for any existing `supabase.from(...)` callsites
export const supabase = new Proxy({} as SupabaseClient, {
  get(_: SupabaseClient, prop: string | symbol) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// Server-side Supabase client (uses service role — never expose to browser)
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { global: { fetch: (url, opts) => fetch(url, { ...opts, cache: "no-store" }) } }
  );
}

// Cookie-aware browser client (anon key) for auth: sign-in/out + reading the
// session in client components. Lazy + memoized so we reuse one instance.
let _browserAuthClient: ReturnType<typeof createBrowserClient> | undefined;
export function createBrowserAuthClient() {
  if (!_browserAuthClient) {
    _browserAuthClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return _browserAuthClient;
}
