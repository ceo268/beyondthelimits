# Beyond the Limits Business Summit

Static summit website + Supabase backend + Razorpay checkout. No build step.

| Path | What it is |
| --- | --- |
| `public/` | **The website. This is the only folder you deploy.** Summit at `/`, organizer dashboard at `/admin/`. |
| `public/js/content.js` | All copy, speakers, pass prices and inclusions, and the **`salesOpen` switch**. |
| `public/js/config.js` | Supabase project URL + publishable key (both are safe to be public). |
| `vercel.json` | Vercel config: serves `public/`, caching + security headers. |
| `.vercelignore` | Keeps `supabase/`, `tests/` and any `.env` out of the Vercel upload. |
| `supabase/migrations/` | Private tables, order/payment functions, organizer allowlist. |
| `supabase/functions/` | `checkout`, `razorpay-webhook` (signed), `ticket-email` (Resend). |
| `tests/` | `node --test tests/*.test.mjs` (payment verification, webhook, email). `tests/checkin.sql` checks ticket codes and check-in. |

## How load and cost are handled (≈1 lakh views/week)

1 lakh views/week ≈ 4.3 lakh views/month, ~0.2 requests/second on average, maybe 20–50 req/s at a launch spike. A static site on a CDN handles that without any servers to scale. **The real cost driver is bandwidth**, so that is what was optimized:

- **Images: 2.6 MB → 0.5 MB.** Speaker photos, hero and logo are resized to their display size and served as WebP. Speaker photos lazy-load, so a visitor who doesn't scroll down downloads ~250 KB in total.
- **Zero backend calls on a normal page view.** Supabase is only called when someone clicks *Get Your Pass* (once per visit, cached 2 min). Page views never touch Supabase or Razorpay, so 1 lakh visitors cost nothing on the backend; only buyers do.
- **Caching.** HTML always revalidates (edits appear instantly after deploy). CSS/JS cached 1 day and versioned with `?v=`; images 7 days; fonts 1 year.

**Hosting: Vercel.** Vercel's free Hobby plan is for non-commercial use only, and selling tickets is commercial, so use **Vercel Pro (~$20/month)**. Pro includes about 1 TB of data transfer (this site needs roughly 100–200 GB/month) and about 10M edge requests. Each page view is ~15–30 file requests, and the speaker photos load only when a visitor scrolls to them. That puts you at or slightly over 10M in a peak month, and any overage is billed at a few dollars per extra million. Check current figures at vercel.com/pricing.

**Supabase:** the free plan includes 500k Edge Function calls/month, far more than ticket purchases will use. But free projects **pause after 7 days without activity**, which would break checkout. Move to **Pro ($25/month)** for the weeks that sales are open.

## Deploy the website

Deploy from the **project root** (the folder with `vercel.json`), not from `public/`.

**Option A: Git (recommended).** Push this folder to GitHub, then on vercel.com: *Add New → Project → Import* the repo. Framework preset: **Other**. Leave the build and install commands empty; `vercel.json` already sets the output directory to `public`. Each push to `main` redeploys automatically.

**Option B: CLI.**
```sh
npx vercel          # first time: link/create the project (preview deploy)
npx vercel --prod   # production deploy
```

**Connect your domain:** Vercel → Project → *Settings → Domains* → add `yourdomain.com` and `www.yourdomain.com`, and choose one to redirect to the other. Then add the DNS records Vercel shows at your domain registrar: usually an `A` record for the root domain and a `CNAME` for `www`. HTTPS is issued automatically once DNS resolves.

**After the domain works:**
1. Add the exact domain(s) to the Supabase `CHECKOUT_ORIGINS` secret, or checkout will refuse requests. Example: `CHECKOUT_ORIGINS=https://yourdomain.com,https://www.yourdomain.com`. Include the `*.vercel.app` URL too if you want to test there.
2. Set `seo.siteUrl` in `public/js/content.js` and the `og:image` URL in `public/index.html` to `https://yourdomain.com/...` so WhatsApp/LinkedIn previews show the logo.
3. Submit `https://yourdomain.com` as the website in your Razorpay account (they review it before enabling Live Mode).

**Whenever you edit CSS or JS**, bump `?v=20261120` in `public/index.html` (and `public/admin/index.html`) so returning visitors get the new file. **If you replace a photo**, give it a new filename.

## Backend status

The Supabase project in `public/js/config.js` already has the migrations applied and the functions deployed, running in Razorpay **Test Mode**. No pass is on sale yet: the catalog is empty because `charge_paise` hasn't been set.

## Tickets, QR codes and gate check-in

- **Buyer details:** name, email and mobile number are all required. A 10-digit Indian mobile is accepted without `+91`.
- **Ticket email:** once Razorpay confirms the payment, a cron job sends the ticket through Resend within about 30 seconds. The ticket includes the buyer's details, a ticket number (for example `DFDC-4FF1`) and an entry QR code embedded in the email. The QR holds only `BTL1:` plus the order's random 128-bit ticket code.
- **Check-in:** go to `/admin/` → **Check-in** → **Start scanning**, and point the phone at the attendee's QR code. The first scan admits the ticket; a second scan shows **Already checked in**, with the time and the organizer who scanned it. Refunded, unpaid and test tickets are refused. You can also type the ticket number. **Undo** reverses a mistaken scan. The camera works on HTTPS only (your Vercel domain), and staff need an organizer login.
- **Test emails:** `summit_private.settings.email_test_tickets` (currently `true`) also emails tickets for Razorpay *test* payments, marked "TEST TICKET · NOT VALID FOR ENTRY", so you can rehearse the whole flow. Turn it off with `update summit_private.settings set email_test_tickets = false;`.
- **Ticket artwork (optional):** put `standard.png`, `premium.png` and `vip.png` (1120×400) in `public/assets/tickets/`, deploy, then set the Supabase secret `TICKET_ART_BASE_URL=https://yourdomain.com/assets/tickets` and redeploy `ticket-email`. Each email then shows the artwork for its pass above the ticket.

## Going live checklist

Do steps 1–5 in Test Mode first, then repeat with Live keys.

1. **Allow your domain** in Supabase secrets: `CHECKOUT_ORIGINS=https://yourdomain.com,https://www.yourdomain.com` (comma-separated, no trailing slash).
   ```sh
   cp supabase/.env.example supabase/.env   # fill in values; never commit this file
   npx supabase secrets set --env-file supabase/.env
   npx supabase functions deploy checkout razorpay-webhook ticket-email
   ```
2. **Set the GST-inclusive amount** each pass charges, in paise (₹1 = 100 paise), and enable it. For example, ₹2,999 + 18% GST = ₹3,538.82 → `353882`. Confirm the exact GST treatment with your accountant.
   ```sql
   update summit_private.pass_tiers set charge_paise = 353882, sale_enabled = true where slug = 'standard';
   -- repeat for 'premium' and 'vip'
   ```
3. **Razorpay webhook:** Razorpay Dashboard → Webhooks → `https://<project-ref>.supabase.co/functions/v1/razorpay-webhook`, events `payment.captured`, `payment.failed`, `refund.processed`, with the same secret as `RAZORPAY_WEBHOOK_SECRET`. Turn on auto-capture.
4. **Organizer access:** create the user in Supabase Auth, then:
   ```sql
   insert into summit_private.admin_users (user_id)
   select id from auth.users where lower(email) = lower('organizer@example.com');
   ```
5. **Open sales on the site:** set `salesOpen: true` in `public/js/content.js`, bump `?v=`, deploy. Do one test purchase and one test refund; check both appear in `/admin/`.
6. **Live mode:** replace the Razorpay keys with `rzp_live_…` keys and register a separate Live webhook. Live sales stay locked until ticket email is configured: `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (on a verified domain) and `TICKET_EMAIL_WORKER_SECRET` (32+ characters). Add the two Vault entries named in `supabase/ops/enable-ticket-email.sql` and run that file in the SQL Editor.
7. Upgrade Supabase to **Pro** before announcing sales.

To stop selling: set `sale_enabled = false` in the database. Payments already in progress still complete. Set `salesOpen: false` on the site too.

## Security notes

- Prices are enforced server-side. The browser can't change the amount charged.
- Payments are confirmed only through a Razorpay HMAC signature check plus a server-side fetch of the payment. Webhooks are signature-verified and idempotent.
- Customer data lives in a private schema with RLS enabled. Only allowlisted organizers can query it through `/admin/`.
- The checkout is rate-limited per IP and per email.
- `vercel.json` sets a CSP that allows only Razorpay and Supabase. It has been tested with the real Razorpay modal.

## Local preview

```sh
python3 -m http.server 8080 --directory public   # http://localhost:8080
node --test tests/*.test.mjs
```
# beyondthelimits
