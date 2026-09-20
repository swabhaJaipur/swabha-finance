# Swabha Financial Control System

One database, one truth. Runs on this Mac and is reachable from any phone or PC on the same WiFi.

## Using it
- **Double-click `Swabha Finance`** in your Applications folder. It starts everything and opens the dashboard.
- It also starts by itself when the Mac logs in, and restarts itself if it ever stops.
- **From another device on the same WiFi:** open `http://192.168.1.12:4040`
  (the exact address is shown in an orange bar at the top of the dashboard, with a Copy button).
- Works on phone browsers. Add it to your home screen for an app-like icon.

## Where things live
| What | Where |
|---|---|
| The app | `~/Applications/Swabha Finance.app` |
| Everything else | `~/Library/Application Support/SwabhaFinance` |
| **The database** | `db/swabha_finance.db` — this one file IS your books |
| Logs | `logs/server.log` |

`~/Documents/Claude/swabha-finance` is a shortcut to the same place.

**Back up `db/swabha_finance.db`.** Copying that single file copies everything.

## Principles built into it
- **Provenance is never lost.** Every entry carries a source — `Tally`, `Manual`, `Recurring`,
  `WhatsApp Log`. Filter by Source to see Tally-only or everything. This is what the old
  spreadsheet got wrong: ₹13.6L appeared with no label and no explanation.
- **Nothing is edited silently.** Every change writes the old value, new value, who and when
  to the audit log. The original Tally figure is always recoverable.
- **Fixed monthly items never post themselves.** They roll forward and wait for you to confirm
  the month, so the books can't gain money you didn't approve.
- **The system shows what it cannot answer.** The Data Quality tab lists every gap and why.

## Moving it to Hostinger later
The server is plain Node with no dependencies. On a VPS it runs as-is behind nginx.
On shared hosting the database moves to MySQL — the schema ports across; `server/db.js`
is the only file that talks to SQLite, deliberately.
