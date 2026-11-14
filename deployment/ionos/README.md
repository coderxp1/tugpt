## P2 derivative: deployment remains prohibited

This is retained deployment documentation, not permission to operate IONOS or any production host. P2-DB-01 authorizes source changes only. Do not run these deployment instructions, migrations, builds or containers under this approval; do not change gateway/DNS/credentials. See `../../docs/auth/sso-reconciliation.md` and the separate review-root manifest. P3 requires a separate explicit approval and completed source review. M2 remains ON HOLD and CF-01 through CF-07 remain OPEN.

# Inactive IONOS login patch - approval required

Do not upload this patch yet. It only works after the production-backed Dashboard and callback have been approved, configured, and validated.

Keep /public/tugpt, index.html, login.html, styles, hosting and navigation unchanged.
Back up login.js and auth-config.js before activation.
1. Upload this login.js to /public/tugpt/login.js (recheck the live file hash first to avoid overwriting newer public-site work).
2. Add `dashboardLoginUrl: "https://dashboard.tugpt.pro/auth/website/start"` to the existing window.TUGPT_AUTH object in auth-config.js. Preserve the production Supabase URL, public key and existing redirectUrl. Do not put a service key in HTML/JS. Do not merely set appUrl.
3. No DNS change. No landing-page redesign. Existing provider buttons and translations are retained.

Without dashboardLoginUrl the script retains the existing flow. With it, it reads the existing provider availability, retires any legacy website session in this browser (local sign-out), then sends the selected provider name only to the Dashboard. Fresh OAuth uses the same production account/provider, with Dashboard-host PKCE cookies. A Google/GitHub browser login may still be remembered by that provider; this is not shared TuGPT session storage.

Roll back the two IONOS files together. Existing old public-site OAuth callbacks must remain allowed during transition. Do not roll back a production Dashboard to the staging database while public production login is enabled.
