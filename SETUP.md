# SETUP — Pursuit (≈10 minutes, no command line)

## 1 · Push to GitHub
Create a new repo and upload exactly this structure:
```
index.html
schema.sql
functions/
  api/
    [[path]].js        ← keep the double square brackets in the filename
```
(ASSUMPTIONS.md / SETUP.md can come along; they're harmless.)

## 2 · Create the database
Cloudflare dashboard → **Storage & Databases → D1 → Create database** → name it `pursuit-db`.
Open the database → **Console** tab → paste the entire contents of `schema.sql` → **Execute**.
You should see `users` and `jobs` under Tables.

## 3 · Create the Pages project
**Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
Build settings: framework **None**, build command **empty**, output directory **/** . Deploy.

## 4 · Bind the database + secrets
Open the Pages project → **Settings**:
- **Bindings** (or Functions → D1 database bindings): Add → D1 database →
  Variable name: `DB` (exactly) → Database: `pursuit-db`.
- **Environment variables** (Production):
  - `ANTHROPIC_KEY` = your Anthropic API key (encrypt it)
  - `SESSION_SECRET` = any long random string, 40+ characters (encrypt it)

## 5 · Redeploy
Deployments tab → ⋯ on the latest deployment → **Retry deployment** (bindings only apply to new deploys).

## 6 · Test
Open the `*.pages.dev` URL → create an account → upload a CV PDF → finish onboarding → hit **Run discovery**. First search takes 30–60 s (it's genuinely searching the web).

## Costs to expect
- Cloudflare: ₹0 at this scale.
- Anthropic: CV extraction ~₹4–8 one-time per user; each discovery sweep ~₹8–15 (5 web searches + Sonnet); tailoring ~₹3–6 per CV. Two active users ≈ a few hundred ₹/month.

## Admin notes
- Forgotten PIN: D1 console → `DELETE FROM users WHERE email='x@y.com';` (they re-register; their jobs are orphaned — also run `DELETE FROM jobs WHERE user_id NOT IN (SELECT id FROM users);`).
- Raise/lower the daily AI budget: `DAILY_UNITS` at the top of `functions/api/[[path]].js`.
- Custom domain: Pages project → Custom domains.
