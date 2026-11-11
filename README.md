# YEPJO Pickleball & Badminton Court — booking PWA

Installable web app for court reservations, announcements, a photo carousel, private
inquiry chat and an admin CMS.

**Stack:** React 19 + TypeScript + Vite · Supabase (Auth with Google, Postgres + RLS,
Storage, Realtime, Edge Functions) · Vercel hosting.

```
src/                 React app (pages/, admin/, components/, lib/, state/)
public/              logo, manifest, service worker (sw.js), offline page
scripts/gen-icons.mjs  builds PWA icons + favicon from public/logo.webp on every build
supabase/migrations/   full schema, RLS, functions, storage bucket, realtime, seed data
supabase/functions/upload-photo/  trusted upload path for photos (admin only)
supabase/tests/        SQL rule tests + concurrency race test
```

---

## 1. Supabase project

1. Create a project (region **Southeast Asia (Singapore)**).
2. **SQL Editor** → paste and run `supabase/migrations/20261111000000_init.sql`
   (or `supabase db push` with the Supabase CLI). It creates every table, policy,
   function, the `photos` bucket and the Realtime publication, and seeds the business
   details and courts.
3. **Edge Function**: deploy `supabase/functions/upload-photo`
   (`supabase functions deploy upload-photo`). Keep **Verify JWT** on. It uses the
   service-role key that Supabase injects automatically — you never copy that key anywhere.
4. **Project Settings → API**: copy the *Project URL* and the *publishable/anon key* for step 3.

## 2. Google sign-in (OAuth)

1. Google Cloud Console → *APIs & Services* → **OAuth consent screen**: External, app
   name "Yepjo", support email, add your domain(s) under *Authorized domains*
   (`vercel.app` is not allowed there; add your own domain when you have one). Publish the app.
2. **Credentials → Create OAuth client ID → Web application**
   - *Authorized JavaScript origins*: `https://<your-vercel-domain>` and `http://localhost:5173`
   - *Authorized redirect URIs*: `https://<PROJECT-REF>.supabase.co/auth/v1/callback`
3. Supabase → **Authentication → Sign In / Providers → Google**: enable, paste the Client
   ID and Client Secret (the secret stays in Supabase only).
4. Supabase → **Authentication → URL Configuration**:
   - *Site URL*: `https://<your-vercel-domain>`
   - *Redirect URLs*: `https://<your-vercel-domain>/auth/callback`,
     `http://localhost:5173/auth/callback` (add each custom domain too)

The app signs in with PKCE and returns to `/auth/callback`. Before redirecting, it stores
the page and any in-progress booking selection, so the user lands back where they were.
New users must add their full name and contact number. The email address is always the
verified Google email.

## 3. Vercel

1. Import the GitHub repo (framework **Vite**, build `npm run build`, output `dist`,
   install `npm ci`).
2. Environment variables (Production + Preview):
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — both are browser-safe; access is
   enforced by RLS. **Never** add the service-role key or the Google secret to Vercel.
3. Deployment Protection: keep *Vercel Authentication* on **Preview only** so the public
   production site is reachable.
4. `vercel.json` adds SPA rewrites, security headers and no-cache for `sw.js`.

Local development: `cp .env.example .env.local`, fill both values, `npm ci`, `npm run dev`.

## 4. First administrator (secure)

Administrators are rows in `public.admins`. No client role can write to that table, so
users cannot grant themselves access. To create the first admin:

1. Sign in on the site once with the owner's Google account.
2. Supabase → **SQL Editor** (runs as the database owner):

   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'owner@example.com';
   ```
3. Reload the site — the **Admin** button appears. Further admins can be added or removed
   in **Admin → Settings → Administrators** (logged in the activity log).

## 5. How the rules are enforced

| Rule | Where |
|---|---|
| No double booking, even under simultaneous requests | `reservations_no_overlap` exclusion constraint (GiST on court + time range) |
| Consecutive slots confirmed together | one reservation row per booking, inserted atomically in `book_court()` |
| Today → one calendar month ahead (Asia/Manila), shorter months handled | `book_court()` (`today + interval '1 month'`) |
| No past start times, operating hours, slot grid, duration limits, per-user cap | `book_court()` |
| Sessions after midnight (e.g. 11 PM–1 AM) | `_business_date()` assigns them to the opening day; UI shows the next-day date |
| Cancellation policy (on/off, cutoff hours) | `cancel_reservation()` |
| Public availability without customer data | `get_availability()` returns court/start/end/state only |
| Walk-ins and blocks use the same conflict checks | `admin_create_reservations()` (all-or-nothing across courts) |
| Admin-only CMS writes | RLS policies using `is_admin()` |
| Private chat | RLS on `conversations`/`messages`; writes only via `send_message()` (1,000-char limit, flood protection, idempotent retries) |
| Photos are WebP ≤ 300,000 bytes | browser optimiser → `upload-photo` Edge Function validates admin + real WebP bytes + size → bucket limits (`image/webp`, 300,000 bytes) as a final safeguard |

## 6. Tests

- `supabase/tests/verify.sql` runs about 100 rule checks inside a transaction and then rolls back:
  first login, profile completion, the booking window, midnight sessions, cancellation,
  admin protection, chat privacy, storage limits and RLS coverage.
  Run it in the SQL Editor or with `psql -f`.
- `supabase/tests/concurrency.sh` fires N simultaneous bookings for one slot from N
  separate connections. Exactly one succeeds. Tested locally with N=20 and N=40.
- On a plain local Postgres, apply `supabase/tests/local_shim.sql` first. It stubs the
  Supabase `auth` and `storage` schemas.

## 7. Settings that still need business input

The CMS shows **"Needs business input"** labels until you confirm each of these:

- **Operating hours**: every court is seeded with 12:00 noon – 1:00 AM daily. The time
  ranges in the reference image were treated as one day's sample availability, not as
  fixed hours.
- **Booking rules**: 60-minute slots, 1–3 hours per booking, up to 6 upcoming bookings
  per customer.
- **Rates**: empty, so no prices are shown. Set an hourly rate per court to show estimates.
- **Cancellation policy**: customers may cancel up to 2 hours before the start time.
- **Contact details**: phone number and Facebook page URL. Only the page name is known so far.
- **Logo**: the source image is 422 px. A larger original would make sharper app icons.
  Replace `public/logo.webp`; the icons are regenerated on the next build.

Payments are not handled online. Reclub is an external link only; bookings are not synced
with Reclub.

---

Developer: Kurama Information Technology Solutions by Chi Omega
