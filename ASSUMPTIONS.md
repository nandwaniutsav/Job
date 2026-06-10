# ASSUMPTIONS & DECISIONS — Pursuit v1.0

Decisions made unilaterally per your "don't stop, document it" instruction. Each is reversible; flagged ones deserve your review first.

## Accounts & auth
1. **Account = email + name + 4-digit PIN.** You asked for Instagram-style accounts but earlier specified a 4-digit passcode, so login is email + PIN. PINs are PBKDF2-hashed (100k iterations, per-user salt), never stored raw. 5 wrong attempts → 15-minute lockout. Sessions are HMAC-signed tokens valid 30 days.
   ⚠️ A 4-digit PIN is convenience-grade security, fine for 1–10 trusted users. Before giving this to strangers, upgrade to a real password — it's a ~20-line change in `functions/api/[[path]].js` (signup/login validation only).
2. **No email verification, no PIN reset flow.** Out of scope for v1. If someone forgets their PIN, you reset it manually in the D1 console (delete the row or update pin_hash). Documented as a Phase 3 item.
3. **Complete user isolation** is enforced server-side: every query filters by `user_id` derived from the verified session token. The client never supplies its own user id.

## Platform
4. **Cloudflare Pages + Pages Functions + D1** (not Firebase, not Render). One repo, one push, zero cold starts, free at this scale, and the API key lives server-side only. Your existing GitHub → Cloudflare Pages flow works unchanged; D1 is a one-time dashboard setup (see SETUP.md).
5. **Render and the old Flask server are fully retired.** The open `/claude` proxy and open `/send-email` relay are gone.

## AI
6. **Your Anthropic key pays for everyone**, guarded by a per-account daily budget of 300 weighted units (web search 10, CV extraction 5, tailoring 3, outreach 2, chat/intake 1). Resets midnight UTC. Tune `DAILY_UNITS` / `COST` at the top of the API file.
7. **Model routing:** Sonnet (`claude-sonnet-4-6`) for search, CV extraction, tailoring, outreach, and advisor chat; Haiku (`claude-haiku-4-5`) for intake questions and JD analysis. Quality where it's the product, cheap where it isn't.
8. **Job discovery uses Anthropic's server-side web search tool** (max 5 searches per run, ≈ $0.05 + tokens; budget ≈ ₹8–15 per discovery sweep). Results must come from real search hits with real URLs; the prompt forbids invented listings and the UI links every job to its source. The fake "generate realistic listings" behaviour from the old app is gone.
9. **HR emails are never guessed.** The old app fabricated recruiter addresses; this one drafts the email and opens it in the user's own Gmail via compose deeplink. No SMTP credentials stored, no open relay, nothing sent from an address the user doesn't own.

## Product scope (v1)
10. **In:** account creation, CV upload (PDF parsed natively by Claude, or pasted text), structured preference onboarding (roles/industries/locations/salary/work mode/availability/blacklist/links), AI-generated adaptive intake questions, live-web job discovery with fit scoring + dedupe, add-by-URL/JD, pipeline (Discovered → Preparing → Applied → Interview → Offer) with notes, per-job CV tailoring, print-to-PDF CV output, outreach drafting + Gmail handoff, advisor chat, follow-up nudges, usage metering.
11. **Out (deliberately):** auto-submitting applications on job portals (needs browser automation — Phase 4), scheduled daily discovery + email digests (Phase 3: add a Cloudflare Cron Trigger calling the search route per user), password reset, multi-CV support.
12. **Advisor chat history IS persisted** server-side (D1 `chats` table, last 60 messages shown, last ~28 sent to the model). A clear-conversation button wipes it. (Changed from v1.0 — "their own AI activity" means it should survive a tab close.)

## v1.1 additions (built in the same session)
17. **Application Kit is complete per job:** tailored CV, cover letter (220–280 words, print-to-PDF), outreach email, follow-up email (only offered once a job is Applied/Interview; aware of how many days have passed), and an interview prep sheet (likely questions with answer angles drawn from the real CV, weak spots, questions to ask them, a one-line pitch). Cover letter and prep sheet persist on the job; follow-ups are generated fresh each time and not stored.
18. **Pipeline is drag-and-drop** on desktop (drag a card between columns to change stage); stage pills in the job modal remain the touch path on mobile.
19. New AI costs: cover letter 3 units, interview prep 3, follow-up 2 — still within the 300/day budget (~10 full application kits a day per user).

## Misc
13. Product name **"Pursuit"** — placeholder, rename freely (it appears in index.html and the system prompt).
14. PDF uploads capped ~5 MB client-side; the PDF itself is never stored — only the extracted text + structured JSON.
15. All model/web-derived strings are HTML-escaped before rendering (real XSS surface now that data comes from the live web).
16. Salary/locations are free-text by design — works for India and France equally.
