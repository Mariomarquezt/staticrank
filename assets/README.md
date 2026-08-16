# assets/ — static files shipped in the plugin zip

Files here are appended to `dist/` and the `.plugin.zip` by
`scripts/build.ts` (the pinned CLI zips only what it writes itself), and
are served from the plugin's `assetBasePath`
(`/uploads/plugins/monkeywebs.seo/<version>/assets/…`) after install.

## tracker.js — contract (task 2.4; MERGED — owned by this repo since B2)

`assets/tracker.js` was built in an isolated Codex worktree and merged;
it and `server/lib/trackerPayload.ts` are now maintained here (B2 review
applied both). The contract both sides implement:

- IIFE browser tracker, injected on every published page by the manifest
  declaration `frontend: { assets: [{ kind: 'script', src:
  'assets/tracker.js', placement: 'body-end', strategy: 'defer' }] }`.
- Reads `window.__mwSeoAnalytics = { endpoint, siteId, enabled }`, which
  the server bakes into the `<head>` seo block via the `publish.html`
  filter BEFORE this script tag — only when analytics is enabled in
  seo-config. No config object (or `enabled: false`) → the tracker
  no-ops.
- Respects DNT and GPC — including legacy serializations: `doNotTrack`
  values `'1'` and `'yes'` on navigator or window, `msDoNotTrack`, and
  `globalPrivacyControl` all bail before any send (review B2#6).
- POSTs a `text/plain` JSON beacon to `endpoint` (same-origin —
  `/admin/api/cms/plugins/monkeywebs.seo/runtime/beacon`, or
  `…/beacon404` when the page served is the site's 404 template). The
  payload shape `{ t, u, r, w, s }` is validated server-side by
  `parseTrackerBeacon` (`server/lib/trackerPayload.ts`), which rejects
  raw bodies over 4096 chars BEFORE parsing (review B2#1, gap G16).
- Privacy: `u` is `location.pathname` ONLY — the query string never
  leaves the page (review B2#4); `r` is the referrer's bare origin, and
  only when cross-origin.
- Parity is enforced by test: the verbatim IIFE runs in a mocked-window
  harness (`server/lib/__tests__/trackerPayload.test.ts`) and its sent
  JSON must equal `buildPageviewPayload`'s output.
- CSP: the page CSP allows the tracker via `script-src 'self'` (the host
  relaxes it for manifest script assets) and the beacon via the default
  `connect-src 'self'`. The inline config tag is allowed by a sha256 hash
  the filter adds to the CSP meta (`server/lib/cspPatch.ts`).

`scripts/build.ts` still carries the staging fallbacks (placeholder
tracker.js / trackerPayload.ts) from the pre-merge window; with the real
files in the repo those branches are dead and the zip ships the real
tracker.
