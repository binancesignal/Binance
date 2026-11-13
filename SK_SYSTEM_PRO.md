# SK SYSTEM PRO — integration notes

## Deploy (in this order)
1. Run `sql/012_sk_system.sql` (same: `supabase/migrations/008_sk_system.sql`) in Supabase.
   If you already ran the first 012, run `sql/013_sk_system_user_scan.sql` instead of re-running it.
2. Deploy the code.
3. Admin → **SK System** → set coins / setups / **visible buckets** (Waiting, Entry ready, Ongoing…) → Enable → Save.
4. **Signals tab → SK System card (admin only)** → choose Top N / All coins → Scan.
   Scanning runs in small batches (`batchSize`) so Binance is not rate-limited / banned.
5. **Scanner tab (everyone)** shows the SK results. Buy / Sell / Invalid filters are removed.
   Only the buckets the admin turned on appear for normal users.
6. Auto-scan via cron-job.org:
   - Schedule `GET /api/cron/sk-system?secret=CRON_SECRET` **every 1 minute**.
   - Admin → SK System → Auto-scan **ON**, interval **5 minutes**.
   - Every 1 min → updates existing open signals (waiting / entry ready / ongoing).
   - Every 5 min → full chunked scan of the configured universe (same as pressing Scan).

## Access model
| Action | Who |
|--------|-----|
| Configure SK + press Scan | Admin only (Signals → SK System card) |
| List setups / Scanner feed | Any user with active plan/trial |
| Cron full scan + track | Secret-protected `/api/cron/sk-system` |

## Stages → Scanner buckets
- **Waiting** ← C_ZONE_REACHED / LTF_CONFIRMATION  
- **Entry ready** ← ENTRY_READY  
- **Ongoing** ← ENTRY_ONGOING / TP hits  
- **Active** ← earlier open stages  
- **Completed / Invalidated**  

Admin sets **Public Scanner shows these buckets** in Admin → SK System.

## Files touched for this flow
- `lib/skSystem/access.js` — read vs admin
- `lib/skSystem/config.js` — `visibleBuckets`, `autoScanIntervalMin: 5`
- `app/api/sk-system/route.js` — public list + bucket filter
- `components/ScannerFeed.js` — SK-only public Scanner (no Buy/Sell/Invalid)
- `components/SkSystemAdmin.js` — visible-buckets checkboxes
- `app/page.js` — SK card admin-only on Signals tab
- `SK_SYSTEM_PRO.md`
