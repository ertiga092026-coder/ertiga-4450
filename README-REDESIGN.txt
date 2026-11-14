ERTIGA MANAGER UI REDESIGN

Copy app.js, index.html, and sw.js from this update into your existing Ertiga Manager project folder, replacing the old files.
Keep your existing core.js, seed.json, manifest.webmanifest, icon files, and lib/jszip.min.js in place.

The Google OAuth Client ID is hardcoded in app.js as requested. It is a public OAuth client identifier, not a client secret. In Google Cloud Console, add the exact local development origin you use (for example http://127.0.0.1:5500) to Authorized JavaScript origins. Add your deployed HTTPS origin before deployment.

Run using VS Code Live Server or another localhost web server. Do not open index.html as a file:// URL.

The login UI is gated behind Google sign-in. A successful sign-in is remembered in the same browser profile for up to 10 days. Google may still require another interactive sign-in if its session or consent is revoked. The remembered browser flag is a convenience gate, not server-side authentication; the app is a static client-side PWA, so do not treat it as a secure multi-user authorization boundary for sensitive data.
