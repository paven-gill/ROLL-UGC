import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Session-aware server client (anon key, respects RLS). Used ONLY to resolve
// WHO is calling (auth.getUser). Actual data queries run on the service-role
// client (createServerClient in ./supabase) after the campaign scope is computed.
//
// This is read-only with respect to cookies: in Route Handlers and Server
// Components we can read the session cookie but should not try to set/refresh it
// here (the middleware handles session refresh). The no-op setters keep
// @supabase/ssr happy without throwing in read-only contexts.
export function createSessionClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // No-op: session refresh is handled in middleware.ts.
        },
      },
    }
  );
}
