# Family Trip Vote — project guide

Voting site for the **June 2027 family reunion**. Stack: **Supabase** (backend/data) +
**GitHub Pages** (static hosting).

## Access
- Invite code: **`JUNE2027FAM`**.

## Deploy
- Hosted on **GitHub Pages** — publishing happens by pushing to the Pages-serving branch
  (`main`/`gh-pages` per repo settings). There's no separate server.

## Environment
- Client uses the Supabase URL + anon (public) key. Restore any non-public secrets from your secrets store.

## Working style
- Keep it simple; prefer editing existing files. Verify the human path, not just the code path.
