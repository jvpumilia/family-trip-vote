# Family Trip Vote (June 2027)

A small private site so the family can see every destination and lodging idea scored the same way,
star two finalists per household, and rank the ballot. Live at https://jvpumilia.github.io/family-trip-vote/

- `docs/` — the website (static; hosted by GitHub Pages)
- `supabase/` — database schema, auth config and the three server functions
  - `signup` — creates accounts (needs the family code, `INVITE_CODE` secret)
  - `ingest` — reads a pasted Airbnb/VRBO link, finds it on the map, creates/scored destinations and scores houses with Claude
  - `admin` — password resets and admin toggles
- `seed/destinations.sql` — the six destinations from the decision packet

## Operating notes
- Supabase project: `family-trip-vote` (ref `kojiwjprtjqrlbfpytov`). DB password is in 1Password ("Family Trip Vote - Supabase").
- Deploy functions: `supabase functions deploy --no-verify-jwt`
- Change the family code: `supabase secrets set INVITE_CODE=...`
- Passwords can't be emailed (no mail server); admins reset them from the Admin tab.
- Publish site changes: commit and push `docs/` to `main`.
