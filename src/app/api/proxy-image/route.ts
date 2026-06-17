import { NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";

const ALLOWED_HOSTS = [
  "fbcdn.net",
  "cdninstagram.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "supabase.co",
];

export async function GET(req: Request) {
  try {
  await requireAuth(req);
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url) return new NextResponse("Missing url", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  const allowed = ALLOWED_HOSTS.some(h => parsed.hostname.endsWith(h));
  if (!allowed) return new NextResponse("Domain not allowed", { status: 403 });

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; bot/1.0)",
      "Referer": "https://www.instagram.com/",
    },
  });

  if (!res.ok) return new NextResponse("Failed to fetch image", { status: 502 });

  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = await res.arrayBuffer();

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    },
  });
  } catch (e) {
    if (isAuthError(e)) return e.response;
    throw e;
  }
}
