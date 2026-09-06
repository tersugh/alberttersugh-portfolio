# Blog V1

Plain HTML, CSS and vanilla JavaScript. The homepage changes by exactly one navigation list item. There is no homepage blog widget, framework, server-side key, or database migration.

## Files and architecture

- `blog/index.html`, `blog/post.html`: accessible public shells for `/blog` and `/blog/<slug>`.
- `admin/blog/index.html`: unlinked admin shell for `/admin/blog`; noindex in HTML and Vercel headers. This route's source is public, while content operations are protected by Supabase.
- `assets/blog/public.js`: published-only reads, safe public comment/count RPCs, likes and pending submissions. The anonymous client never loads the admin session.
- `assets/blog/admin.js`: password authentication, authorized-user UI, Quill editor, optimistic edit conflict detection, cover storage and pending moderation.
- `assets/blog/shared.js`: Supabase client setup, validation, DOMPurify allowlist and DOM helpers. Untrusted text uses `textContent`; rich text is sanitized on save and display. No embedded HTML/images/video/scripts in post content; covers are separate.
- `assets/blog/blog.css`: separate editorial styles using the portfolio's existing colors and typefaces.
- `scripts/build.mjs`, `scripts/config.mjs`: bundle dependencies with esbuild, copy only allowlisted public files to `dist`, generate public browser config. No `.env`, source documentation or test files are deployed.
- `scripts/preview.mjs`: local static server reproducing the three route mappings.
- `tests/blog.test.mjs`: configuration, sanitization, mocked public flows, draft-unavailable state and route tests.
- `vercel.json`: explicit rewrites, build output and admin noindex/no-store headers.

Dependencies: Supabase JS, Quill 2, DOMPurify. Build/test dependencies: esbuild and jsdom. `package-lock.json` locks exact resolutions. No CDN scripts are used; the existing Google Fonts approach is retained.

## Exact Vercel configuration

1. Keep the existing Vercel project connected to this repository. Do not change the domain or homepage.
2. In Project Settings → Build and Deployment, use **Framework Preset: Other**, repository root as Root Directory, **Build Command: `npm run build`**, **Output Directory: `dist`**, **Install Command: `npm ci`**, and **Node.js 24.x**. The build and output defaults are also in `vercel.json`.
3. In Project Settings → Environment Variables, add these to each environment where the blog should run (Production and/or Preview):
   - `SUPABASE_URL`: the HTTPS Project URL from Supabase, e.g. `https://your-project.supabase.co`.
   - `SUPABASE_PUBLISHABLE_KEY`: the Project API publishable key beginning `sb_publishable_`. The build deliberately rejects secret keys and legacy JWT keys. Generate/use a current publishable key in Supabase if necessary.
   - `SUPABASE_ADMIN_USER_ID`: the UUID of the **existing authorized Supabase Auth user** from Authentication → Users. This ID is public UI configuration, not a credential or security boundary. It must match the user enforced by the existing policies.
4. Redeploy after changing any of these settings. Static browser configuration is generated **at build time**, not at request time. Only those three allowlisted values enter the output. Never add a service-role/secret key.
5. Open `/`, `/blog`, a published `/blog/<slug>`, and `/admin/blog` directly and refresh each route. Vercel serves separate static shells through rewrites, not a catch-all homepage fallback. No Supabase migration or function deployment is part of this change.
6. `blog-v1` can use a Preview deployment. Nothing in this implementation commits, pushes or promotes a deployment.

For local use, copy `.env.example` to `.env`, fill in the three values, then run:

```sh
npm ci
npm test
npm run build
npm run preview
```

Open `http://127.0.0.1:4173`. Node loads `.env` only during the build. The existing `.env` is preserved and ignored by git. Never serve the repository root publicly; deploy/serve only `dist`.

## Exact Supabase assumptions — verify against the existing backend

No policies are added, removed or weakened. Frontend checks do not replace these requirements:

- Tables are in the exposed `public` schema. IDs and post foreign keys are UUIDs; timestamps are standard Postgres timestamps; `content` is HTML in a text column; `tags` is a text array (JSON arrays also deserialize, but existing writes must accept an array). Status values are exactly `draft` and `published`. New post IDs are client-generated UUIDs.
- `posts.slug` has a database UNIQUE constraint. If it does not, add that constraint after reviewing any existing duplicates; this frontend cannot make concurrent slug creation unique by itself. `likes` retains UNIQUE(`post_id`, `visitor_id`); `visitor_id` accepts a UUID string. Default IDs/created_at exist for comments and likes. Post created_at has a default. The admin writes updated_at and published_at; triggers may also maintain updated_at.
- Anonymous roles can SELECT **only published** posts. Existing policies authorize only the designated user's `auth.uid()` to insert/update/select drafts and manage comments/storage. **A policy granting every authenticated user admin access is insufficient.** Other authenticated users must fail direct writes and draft reads even if they alter browser config.
- Anonymous comments INSERT is allowed only for a published post with `approved = false`; anonymous direct SELECT cannot expose email or pending comments. Approved comments are read via the RPC only. Anonymous likes INSERT is restricted to published posts; anonymous direct management remains forbidden.
- `get_public_comments(p_post_id uuid)` returns a **set/table of rows** with `id`, `name`, `content`, `created_at`, containing only approved comments on a currently published post and no email field. It supports PostgREST `.select()`, order and range. The client requests only those four fields as additional protection. A JSON scalar/JSON aggregate return would need adaptation.
- `get_post_like_count(p_post_id uuid)` returns a scalar nonnegative integer. Both RPCs must enforce published-post visibility themselves, including when implemented with SECURITY DEFINER. The frontend cannot validate their internals. Returning comments or counts for an unpublished post must not bypass existing visibility rules.
- `blog-covers` is public, with SELECT for public access and INSERT/UPDATE/DELETE only for the same authorized admin. Allow JPEG, PNG and WebP with a 5 MB limit at the bucket level as well as client validation. Files use `<post UUID>/<random UUID>.<ext>` and uploads never overwrite existing paths.
- Covers in a **public bucket are publicly accessible if their URLs are known**, including draft covers. Draft post text/records are protected by RLS; truly private draft images would require a separate private storage design.
- Supabase Auth email/password login is enabled and the existing authorized user has a password. This UI offers no sign-up. Set Supabase Site URL to the production origin; password sign-in does not need an OAuth callback. Existing OAuth-only users need a password configured through the project's existing account-management process. Use the existing Supabase account recovery workflow for password resets.

A real project URL/key/user ID and a live session were not provided during implementation. Mocked tests are not proof that deployed policies or RPC definitions satisfy these assumptions. Perform the live checks below before calling the integration production-verified.

## Admin workflow and image lifecycle

Visit `/admin/blog` manually, sign in, create or open a post, edit, then select Save draft or Publish. Saving a published post as draft unpublishes it and clears published_at; republishing starts a new publication date. Edits to a published post keep its existing date. Unsaved edits trigger a leave warning; simultaneous saves check the prior updated_at value and reject stale edits.

Select a file to upload/replace a cover, or Remove cover to clear it; then save. The new post reference is saved before the old file is deleted. Automatic deletion only touches images in that post's managed UUID directory. Legacy/shared/external images are retained with a notice. If upload succeeds but save fails or the response is ambiguous, the upload is retained rather than risking deletion of a referenced file. Reopen the post before retrying and remove confirmed orphan files in Supabase Storage. This is a deliberate two-service transaction limitation.

The pending queue supports approve or permanent delete, with confirmation for deletion. It does not render emails even in the admin queue. Published/approved comment editing or a full comment archive is outside V1.

## Manual acceptance checklist

- [ ] Homepage diff is only Blog immediately after Contact; its link inherits standard nav styling. Hire me is the sole prominent navigation CTA. No blog widget or public admin link.
- [ ] At desktop and narrow widths, blog navigation, typography, forms, editor and long content remain readable and keyboard accessible. Homepage still hides standard links below 768px, as it did before.
- [ ] With correct config, empty, loading, error and populated listing/post states work. Direct navigation and refresh work for all routes on Vercel.
- [ ] Authorized account can create, reopen, edit, save draft, publish and unpublish. A second tab's stale save is rejected. Duplicate slug produces a useful error.
- [ ] Signed out and using a different authenticated account, direct API attempts to insert/update posts, read drafts, approve comments and write storage fail. Changing the configured admin UUID does not grant backend access.
- [ ] Draft is absent from listing and direct slug lookup. After unpublishing, a fresh anonymous request cannot fetch the post or comments via either RPC. Check this even in a browser with an active admin session.
- [ ] Upload, replace and remove each supported cover type; verify saved references and old managed file deletion. Invalid format/oversize files fail. A failed save does not delete the existing cover.
- [ ] A first like increments the count. Reload preserves Liked. Concurrent duplicate insert returns a handled 23505. Simulate blocked localStorage and network errors. Clearing localStorage can create another visitor; this is expected, not abuse prevention.
- [ ] Name/email/comment required and length validation works; submission stays pending. Public HTML, RPC responses and DOM contain no email addresses or pending comments. Approve makes a comment visible; delete removes a pending comment.
- [ ] Rich HTML containing scripts, event attributes, unsafe links or embeds cannot execute; comment/title/tag HTML displays as plain text.
- [ ] Expired session, denied RLS, unavailable RPC and network failures produce recoverable messages. Saved work remains saved if list refresh or old-image cleanup fails.
- [ ] Browser title and description update to the post's title/excerpt; admin has noindex. Confirm social-preview expectations below.
- [ ] Inspect deployed `dist`: only static assets and public config; no `.env`, secret/service-role key, test code or documentation.

## Remaining limitations

- Client rendering updates post title/excerpt metadata for JavaScript-capable crawlers, but social scrapers may see generic shell metadata. Missing/unpublished slugs show an unavailable state with HTTP 200 due to the static rewrite. Per-post server-rendered metadata and true HTTP 404 responses need a small server function or rebuild workflow, intentionally outside this static V1.
- Existing homepage mobile navigation hides all standard links, including Blog. No homepage styling or layout was changed to add a mobile menu.
- Browser visitor IDs and database uniqueness stop accidental duplicate likes per identifier, not determined abuse. Public comment submission has browser validation but no CAPTCHA/rate limiter. Enforce authoritative length/check constraints and anti-abuse limits in the backend if not already present; this change does not alter existing policies.
- Public content already loaded cannot be recalled from an open browser when unpublished. Fresh requests are filtered by published status and RLS. Public covers remain public as described above.
- List pagination is offset-based and can shift while new posts/comments arrive; refresh to obtain a current view. Slug changes do not create redirects. The editor intentionally supports only basic formatting and links.
- Live Supabase integration, real authorization policies and production Vercel routing require the configured acceptance checks above.

## Dependency audit

The audit reports one low-severity advisory for Quill 2.0.3 HTML export ([GHSA-v3m3-f69x-jf25](https://github.com/advisories/GHSA-v3m3-f69x-jf25)); the advisory lists no patched release. Exported HTML is treated as untrusted and immediately sanitized through DOMPurify before persistence; existing content is sanitized before editor import and public rendering. Unsafe attributes/URLs and embeds are removed by a narrow allowlist. Keep this mitigation and recheck the advisory when updating Quill. Do not bypass sanitization or blindly use the audit's suggested downgrade.

## Verification completed (6 September 2026)

- `npm test`: 11/11 passed. Tests exercise real bundled frontend modules with mocked Supabase HTTP responses: public reads, pending submission, email-free rendering, duplicate likes, admin identity selection, publishing, stale saves, cover replacement/removal order, pending moderation, and safe submission while RPCs are delayed. These are not live backend tests.
- `npm run build`: passed using clearly fake public configuration for compilation/local preview only. The existing `.env` was not changed. Real configuration is still required.
- `git diff --check`: passed. Homepage comparison against HEAD confirmed that removing the added Blog line restores the original file exactly.
- Local HTTP checks: `/`, `/blog`, `/blog/test-slug`, `/admin/blog` returned the correct shells; `/.env` returned 404. Vercel rewrite destinations exist, but no deployment was performed.
- Browser review: desktop/mobile blog shell and error state, mobile admin login, and direct post-route shell inspected. Populated admin/editor and post flows were exercised in jsdom with mocks; no live authenticated browser session was available.
- Source review: no service-role/secret credentials added; public client never persists/loads admin sessions; published filters present on both public post queries; public comments exclusively use the safe RPC and email-free projection; comments insert `approved: false`; duplicate-like `23505` handled; all rich text display/import/export uses sanitization. Existing RLS policies were not changed or independently verified.
- Built output is allowlisted; no `.env` or documentation/tests included. Secret-key/JWT pattern scan passed.
- Dependency audit: one low-severity Quill export advisory remains, with sanitization mitigation documented above.
- Branch remains `blog-v1`. No commit, push, database policy change, or deployment was performed.

## Complete changed-file list

Paths below are relative to `/Users/alberttersugh/Development/alberttersugh-portfolio`.

- `.env.example`
- `.gitignore`
- `BLOG.md`
- `admin/blog/index.html`
- `assets/blog/admin.js`
- `assets/blog/blog.css`
- `assets/blog/public.js`
- `assets/blog/shared.js`
- `blog/index.html`
- `blog/post.html`
- `index.html`
- `package-lock.json`
- `package.json`
- `scripts/build.mjs`
- `scripts/config.mjs`
- `scripts/preview.mjs`
- `tests/blog.test.mjs`
- `vercel.json`
