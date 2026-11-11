// upload-photo — the trusted upload path for every photo in the app
// (carousel + announcements). No external imports, so it can be pasted
// straight into the Supabase dashboard editor.
//
// The browser converts and compresses each image, but nothing it sends is
// trusted. This function checks that:
//   1. the caller is signed in (the token is verified by Supabase Auth),
//   2. the caller is an administrator (public.admins),
//   3. the bytes are a genuine WebP file of at most 300,000 bytes.
// Only then is the photo stored, using the service-role key that Supabase
// injects into this server runtime (it never reaches the browser).
// The `photos` bucket also rejects non-WebP files and anything over 300,000 bytes.
//
// Dashboard setting: "Verify JWT with legacy secret" = OFF (this code does its own checks).

const MAX_BYTES = 300_000;
const BUCKET = "photos";
const FOLDERS = new Set(["carousel", "announcements", "payments"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-folder",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** RIFF container + WEBP form type + a VP8 / VP8L / VP8X first chunk + consistent RIFF size. */
function isWebp(b: Uint8Array): boolean {
  if (b.length < 20) return false;
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return false;
  if (!["VP8 ", "VP8L", "VP8X"].includes(tag(12))) return false;
  const riffSize = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
  return riffSize + 8 <= b.length + 1 && riffSize + 8 >= b.length - 1;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return reply(405, { error: "Use POST." });

    const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!base || !serviceKey) return reply(500, { error: "Upload service is not configured." });
    const svc = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

    // 1. Who is calling? Supabase Auth verifies the user's access token.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return reply(401, { error: "Please sign in." });
    const userRes = await fetch(`${base}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return reply(401, { error: "Your session has expired. Please sign in again." });
    const user = (await userRes.json()) as { id?: string; email?: string };
    if (!user?.id) return reply(401, { error: "Your session has expired. Please sign in again." });

    // 2. Are they an administrator?
    const adminRes = await fetch(
      `${base}/rest/v1/admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`,
      { headers: svc },
    );
    if (!adminRes.ok) return reply(500, { error: "Could not check administrator access." });
    const admins = (await adminRes.json()) as unknown[];
    if (!Array.isArray(admins) || admins.length === 0) {
      return reply(403, { error: "Administrator access is required to upload photos." });
    }

    // 3. Validate the destination and the actual bytes.
    const folder = req.headers.get("x-folder") ?? "";
    if (!FOLDERS.has(folder)) return reply(400, { error: "Unknown photo folder." });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return reply(413, { error: "Photo is larger than 300 KB (300,000 bytes)." });

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return reply(400, { error: "The upload was empty." });
    if (bytes.length > MAX_BYTES) return reply(413, { error: "Photo is larger than 300 KB (300,000 bytes)." });
    if (!isWebp(bytes)) return reply(415, { error: "Photo is not a valid WebP file." });

    // 4. Store it.
    const path = `${folder}/${crypto.randomUUID()}.webp`;
    const up = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "image/webp", "Cache-Control": "max-age=31536000", "x-upsert": "false" },
      body: bytes,
    });
    if (!up.ok) {
      const detail = await up.text().catch(() => "");
      return reply(500, { error: `Storage rejected the photo. ${detail}`.trim() });
    }

    // 5. Activity log (best effort).
    await fetch(`${base}/rest/v1/activity_logs`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        actor_id: user.id, actor_email: user.email ?? null, action: "photo.upload",
        entity: "storage", entity_id: path, details: { bytes: bytes.length },
      }),
    }).catch(() => undefined);

    return reply(200, { path, bytes: bytes.length });
  } catch (e) {
    return reply(500, { error: `Upload failed: ${e instanceof Error ? e.message : String(e)}` });
  }
});
