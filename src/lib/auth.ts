import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSessionClient } from "@/lib/supabase-server";

export type Role = "super_admin" | "brand_admin";

export interface AuthContext {
  userId: string;
  email: string | null;
  role: Role;
  /**
   * brand_admin: their one fixed campaign.
   * super_admin: the *active* campaign chosen via the x-campaign-id header,
   *              or null = "all campaigns" (no filter).
   */
  campaignId: string | null;
  isSuperAdmin: boolean;
}

/** Thrown by require* helpers; carries the HTTP response to return. */
export class AuthError extends Error {
  response: NextResponse;
  constructor(response: NextResponse) {
    super("auth error");
    this.response = response;
  }
}

const HEADER = "x-campaign-id";

/**
 * Resolve the caller. Returns null if unauthenticated.
 * Reads the session cookie, then joins `profiles` for role + campaign.
 *
 * Trust model: a brand_admin's campaign is ALWAYS taken from their profile;
 * the client-supplied x-campaign-id header is ignored for them. Only a
 * super_admin may use the header to pick which campaign to view.
 */
export async function getAuthContext(req: Request): Promise<AuthContext | null> {
  const session = createSessionClient();
  const { data: userData } = await session.auth.getUser();
  const user = userData?.user;
  if (!user) return null;

  const { data: profile } = await session
    .from("profiles")
    .select("role, campaign_id")
    .eq("id", user.id)
    .single();

  if (!profile) return null;

  const isSuperAdmin = profile.role === "super_admin";

  let campaignId: string | null;
  if (isSuperAdmin) {
    // super_admin: active campaign from header, else null (all campaigns)
    const header = req.headers.get(HEADER);
    campaignId = header && header !== "all" ? header : null;
  } else {
    // brand_admin: locked to their own campaign; header is never trusted
    campaignId = profile.campaign_id ?? null;
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    role: profile.role as Role,
    campaignId,
    isSuperAdmin,
  };
}

/** 401 if unauthenticated. Throws AuthError otherwise returns the context. */
export async function requireAuth(req: Request): Promise<AuthContext> {
  const ctx = await getAuthContext(req);
  if (!ctx) {
    throw new AuthError(
      NextResponse.json({ error: "Not authenticated" }, { status: 401 })
    );
  }
  return ctx;
}

/** 403 unless the caller is a super_admin. */
export async function requireSuperAdmin(req: Request): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (!ctx.isSuperAdmin) {
    throw new AuthError(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
  }
  return ctx;
}

/**
 * The creator ids the caller may touch.
 *   super_admin viewing "all" (campaignId null) -> null  (= no filter)
 *   otherwise -> string[] of creator ids in the scoped campaign
 *
 * Use the returned value to scope child-table queries by `.in("creator_id", ids)`.
 * When null, skip the filter.
 */
export async function allowedCreatorIds(
  db: SupabaseClient,
  ctx: AuthContext
): Promise<string[] | null> {
  if (ctx.isSuperAdmin && ctx.campaignId === null) return null;
  if (!ctx.campaignId) return []; // brand_admin with no campaign assigned: see nothing
  const { data } = await db
    .from("creators")
    .select("id")
    .eq("campaign_id", ctx.campaignId);
  return (data ?? []).map((c: { id: string }) => c.id);
}

/**
 * Guard a single creator id. Throws AuthError(403) if the creator is outside
 * the caller's campaign scope. super_admin viewing "all" passes everything.
 */
export async function assertCreatorInScope(
  db: SupabaseClient,
  ctx: AuthContext,
  creatorId: string
): Promise<void> {
  if (ctx.isSuperAdmin && ctx.campaignId === null) return;
  const { data } = await db
    .from("creators")
    .select("campaign_id")
    .eq("id", creatorId)
    .single();
  if (!data || data.campaign_id !== ctx.campaignId) {
    throw new AuthError(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );
  }
}

/**
 * Apply campaign scope to a Supabase query on a table that has a `creator_id`
 * column. When `ids` is null (super_admin viewing all) the query is unchanged;
 * otherwise it is constrained to `creator_id IN (ids)`.
 */
export function scopeToCreators<Q>(query: Q, ids: string[] | null): Q {
  if (ids === null) return query;
  // Cast keeps the public generic shallow (avoids TS2589 deep-instantiation on
  // Supabase's builder types) while still chaining .in() on the live builder.
  return (query as unknown as { in: (col: string, vals: string[]) => Q }).in(
    "creator_id",
    ids
  );
}

/**
 * Catch any thrown AuthError and return its HTTP response.
 * Usage in a route: `catch (e) { if (isAuthError(e)) return e.response; throw e; }`
 */
export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}
