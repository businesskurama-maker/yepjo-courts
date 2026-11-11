// Trusted upload path for every photo in the app (carousel + announcements).
//
// The browser converts and compresses the image, but nothing it says is trusted:
// this function checks that the caller is an administrator, that the bytes are a
// genuine WebP file, and that the file is at most 300,000 bytes. Only then is it
// stored, using the service-role key that exists solely in this server runtime.
// The bucket itself also rejects non-WebP files and anything over 300,000 bytes.
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_BYTES = 300_000;
const BUCKET = "photos";
const FOLDERS = new Set(["carousel", "announcements"]);

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
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  const url = Deno.env.get("SUPABASE_URL")!;
  // Supabase injects these into every Edge Function; they never reach the browser.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return reply(500, { error: "Upload service is not configured." });
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1. Who is calling? (verified against Supabase Auth, not just decoded)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Please sign in." });
  const { data: userData, error: userError } = await service.auth.getUser(token);
  if (userError || !userData?.user) return reply(401, { error: "Your session has expired. Please sign in again." });

  // 2. Are they an administrator?
  const { data: adminRow, error: adminError } = await service
    .from("admins").select("user_id").eq("user_id", userData.user.id).maybeSingle();
  if (adminError) return reply(500, { error: "Could not check administrator access." });
  if (!adminRow) return reply(403, { error: "Administrator access is required to upload photos." });

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
  const { error: uploadError } = await service.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/webp",
    cacheControl: "31536000",
    upsert: false,
  });
  if (uploadError) return reply(500, { error: `Storage rejected the photo: ${uploadError.message}` });

  await service.from("activity_logs").insert({
    actor_id: userData.user.id,
    actor_email: userData.user.email,
    action: "photo.upload",
    entity: "storage",
    entity_id: path,
    details: { bytes: bytes.length },
  });

  return reply(200, { path, bytes: bytes.length });
});
