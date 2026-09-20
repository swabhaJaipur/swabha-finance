#!/usr/bin/env python3
"""Build swabha_finance.db from the rich Tally DB + the xlsx masters.
Source of truth = SQLite. Nothing is discarded; everything questionable is flagged."""
import sqlite3, os, re, sys, glob, datetime, collections, unicodedata
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from xlsxread import Book

TALLY_DB = os.path.expanduser("~/Documents/Claude/swabha-data/swabha.db")
XLSX_DIR = os.path.expanduser("~/Downloads/Swabha Financial Dashboard")
OUT      = os.path.join(ROOT, "db", "swabha_finance.db")

# ---------------------------------------------------------------- helpers
def norm_date(s):
    if s in (None, ""): return None
    s = str(s).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s): return s
    if re.fullmatch(r"\d+(\.\d+)?", s):           # excel serial
        return (datetime.date(1899,12,30)+datetime.timedelta(days=int(float(s)))).isoformat()
    for fmt in ("%d-%b-%Y","%d/%m/%Y","%d-%m-%Y","%Y/%m/%d","%d %b %Y","%b %d, %Y"):
        try: return datetime.datetime.strptime(s, fmt).date().isoformat()
        except ValueError: pass
    return None

def fy_of(iso):
    y, m = int(iso[:4]), int(iso[5:7])
    return f"{y}-{y+1}" if m >= 4 else f"{y-1}-{y}"

def num(v):
    try:
        if v in (None, ""): return 0.0
        return float(v)
    except (TypeError, ValueError): return 0.0

def slug(s):
    s = unicodedata.normalize("NFKD", str(s or "")).lower()
    s = re.sub(r"\b(pvt|private|limited|ltd|llp|the|and|&|co|company|homes?|stays?|hospitality|enterprises?|associates?)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def toks(s): return set(t for t in slug(s).split() if len(t) > 2)

def jacc(a, b):
    A, B = toks(a), toks(b)
    return len(A & B) / len(A | B) if A and B else 0.0

# ---------------------------------------------------------------- build
if os.path.exists(OUT): os.remove(OUT)
db = sqlite3.connect(OUT)
db.executescript(open(os.path.join(ROOT, "db", "schema.sql")).read())

log = []
def note(msg): log.append(msg); print(msg)

# ---- categories -------------------------------------------------------
CATS = [
 ("Service Revenue","revenue","variable"), ("Housekeeping Services","revenue","variable"),
 ("Laundry Services","revenue","variable"), ("Regular Cleaning","revenue","variable"),
 ("Deep Cleaning","revenue","variable"),    ("Revenue Adjustment","revenue","variable"),
 ("Supplier Purchases","cogs","variable"),  ("Consumables","cogs","variable"),
 ("Cleaner Wages","cogs","variable"),       ("Transport","cogs","variable"),
 ("Salaries","opex","fixed"),               ("Rent","opex","fixed"),
 ("Software & Subscriptions","opex","fixed"),("Bank Charges","opex","variable"),
 ("Marketing","opex","variable"),           ("Professional Fees","opex","variable"),
 ("Capital / Asset","capex","n/a"),         ("Owner Funding","transfer","n/a"),
 ("Miscellaneous","other","n/a"),           ("Unclassified","other","n/a"),
]
db.executemany("INSERT INTO categories(name,kind,cost_behaviour) VALUES(?,?,?)", CATS)
CAT = {r[0]: r[1] for r in db.execute("SELECT name,category_id FROM categories")}
note(f"categories: {len(CATS)}")

# ---- xlsx masters -----------------------------------------------------
src = None
for p in glob.glob(os.path.join(XLSX_DIR, "*.xlsx")):
    b = Book(p)
    if "Daily_Ledger" in dict(b.sheets): src = b
if src is None: sys.exit("!! could not find the workbook containing Daily_Ledger/Properties/Hosts")
sh = dict(src.sheets)

def table(name):
    rows = src.rows(sh[name]); hdr = [h.strip() if h else h for h in rows[0]]
    idx = {h: i for i, h in enumerate(hdr)}
    out = []
    for r in rows[1:]:
        if not any(r): continue
        r = r + [None] * (len(hdr) - len(r))
        out.append({h: r[idx[h]] for h in hdr if h})
    return out

# hosts
for h in table("Hosts"):
    ph = str(h.get("Phone") or "")
    db.execute("""INSERT OR IGNORE INTO hosts(name,email,phone,phone_status,active,joined_date)
                  VALUES(?,?,?,?,?,?)""",
        (str(h["Host Name"]).strip(), h.get("Email"),
         None if ph.startswith("PENDING") else ph,
         "pending" if ph.startswith("PENDING") else "ok",
         1 if h.get("Active") == "Yes" else 0, norm_date(h.get("Joined"))))
HOST = {r[0]: r[1] for r in db.execute("SELECT name,host_id FROM hosts")}
note(f"hosts: {len(HOST)}")

# properties + cleaners
pkg_re = re.compile(r"(\d+)\s*cleanings?", re.I)
for p in table("Properties"):
    hid = HOST.get(str(p.get("Host") or "").strip())
    pkg = str(p.get("Package") or p.get("Package ") or "").strip()
    m = pkg_re.search(pkg)
    db.execute("""INSERT OR REPLACE INTO properties(property_id,name,type,host_id,city,bedrooms,bathrooms,
                    max_guests,onboarding_date,package_type,package_rate,cleanings_included,
                    per_cleaning_price,active)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (p["Property ID"], p["Property Name"], p.get("Type"), hid, p.get("City"),
         int(num(p.get("Bedrooms"))), int(num(p.get("Bathrooms"))), int(num(p.get("Max Guests"))),
         norm_date(p.get("Onboarding Date")), pkg, None, int(m.group(1)) if m else None,
         num(p.get("Per Cleaning Price")) or None,
         1 if p.get("Active") == "Yes" else 0))
    cl = (p.get("Cleaner Assigned") or "").strip()
    if cl:
        db.execute("INSERT OR IGNORE INTO cleaners(name) VALUES(?)", (cl,))
        cid = db.execute("SELECT cleaner_id FROM cleaners WHERE name=?", (cl,)).fetchone()[0]
        db.execute("""INSERT OR IGNORE INTO property_cleaners(property_id,cleaner_id,from_date)
                      VALUES(?,?,?)""", (p["Property ID"], cid, None))
nprop = db.execute("SELECT count(*) FROM properties").fetchone()[0]
nclean = db.execute("SELECT count(*) FROM cleaners").fetchone()[0]
note(f"properties: {nprop} | cleaners: {nclean}")

# ---- parties + transactions from the Tally DB -------------------------
t = sqlite3.connect(TALLY_DB); t.row_factory = sqlite3.Row
for r in t.execute("SELECT * FROM parties"):
    grp = r["party_group"] or ""
    kind = "customer" if "Debtor" in grp else "vendor" if "Creditor" in grp else None
    db.execute("""INSERT OR IGNORE INTO parties(display_name,tally_name,party_group,gstin,state,aliases,kind)
                  VALUES(?,?,?,?,?,?,?)""",
        (r["display_name"], r["tally_name"], grp, r["gstin"], r["state"], r["aliases"], kind))
# parties referenced by transactions but absent from the parties table
for r in t.execute("SELECT DISTINCT party, party_group, gstin, state FROM transactions WHERE party<>''"):
    db.execute("""INSERT OR IGNORE INTO parties(display_name,tally_name,party_group,gstin,state,kind)
                  VALUES(?,?,?,?,?,?)""",
        (r["party"], r["party"], r["party_group"], r["gstin"], r["state"],
         "customer" if "Debtor" in (r["party_group"] or "") else
         "vendor" if "Creditor" in (r["party_group"] or "") else None))
PARTY = {r[0]: r[1] for r in db.execute("SELECT display_name,party_id FROM parties")}
note(f"parties: {len(PARTY)}")

DIRECTION = {"Sales":"in","Receipt":"in","Purchase":"out","Payment":"out",
             "Credit Note":"out","Journal":"out"}
DEFCAT = {"Sales":"Service Revenue","Receipt":"Service Revenue","Purchase":"Supplier Purchases",
          "Payment":"Miscellaneous","Credit Note":"Revenue Adjustment","Journal":"Unclassified"}

idmap = {}
for r in t.execute("SELECT * FROM transactions ORDER BY txn_date, txn_id"):
    d = norm_date(r["txn_date"])
    if not d: continue
    vt = r["voucher_type"] or "Journal"
    gross = num(r["gross_total"]); tax = num(r["taxable_value"])
    cg, sg, ig = num(r["cgst"]), num(r["sgst"]), num(r["igst"])
    gsttot = cg + sg + ig
    treat = "none"
    if gsttot > 0:
        treat = "inclusive" if abs((tax + gsttot) - gross) <= max(2.0, gross*0.005) else "exclusive"
    cur = db.execute("""INSERT INTO transactions(voucher_no,voucher_type,txn_date,fy,month,direction,
            party_id,category_id,gross_amount,taxable_value,cgst,sgst,igst,round_off,gst_treatment,
            status,narration,source,source_ref,needs_review)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (r["voucher_no"], vt, d, fy_of(d), d[:7], DIRECTION.get(vt,"out"),
         PARTY.get(r["party"]), CAT[DEFCAT.get(vt,"Unclassified")], gross,
         tax or None, cg, sg, ig, num(r["round_off"]), treat,
         "Cancelled" if (r["status"] or "").lower().startswith("cancel") else "Posted",
         r["narration"], r["source"] or "Tally", r["voucher_no"],
         1 if vt == "Journal" else 0))
    idmap[r["txn_id"]] = cur.lastrowid

SERVCAT = {"Regular Cleaning":"Regular Cleaning","Deep Cleaning":"Deep Cleaning",
           "Laundry Services":"Laundry Services","Housekeeping Services":"Housekeeping Services"}
nl = 0
for r in t.execute("SELECT * FROM transaction_lines"):
    if r["txn_id"] in idmap:
        db.execute("INSERT INTO transaction_lines(txn_id,service,amount) VALUES(?,?,?)",
                   (idmap[r["txn_id"]], r["service"], num(r["amount"]))); nl += 1
ntx = db.execute("SELECT count(*) FROM transactions").fetchone()[0]
note(f"transactions: {ntx} | lines: {nl}")

# ---- receivables ------------------------------------------------------
ninv = 0
for r in t.execute("SELECT * FROM outstanding"):
    pid = PARTY.get(r["party"])
    db.execute("""INSERT INTO invoices(party_id,period,cleaning,laundry,total,received,status,source,notes)
                  VALUES(?,?,?,?,?,?,?,?,?)""",
        (pid, r["period"], num(r["cleaning"]), num(r["laundry"]), num(r["total"]),
         num(r["receipt"]), "paid" if num(r["closing_balance"]) <= 0 else
         "part" if num(r["receipt"]) > 0 else "open", "tally_outstanding",
         None if pid else f"unmatched party: {r['party']}"))
    ninv += 1
note(f"invoices (outstanding): {ninv}")

# ---- auto-link parties to hosts / properties --------------------------
props = list(db.execute("SELECT property_id,name,host_id FROM properties"))
hosts = list(db.execute("SELECT host_id,name FROM hosts"))
auto_h = auto_p = 0
for pid, dname in db.execute("SELECT party_id,display_name FROM parties").fetchall():
    bh = max(hosts, key=lambda h: jacc(dname, h[1])) if hosts else None
    if bh and jacc(dname, bh[1]) >= 0.5:
        db.execute("UPDATE parties SET host_id=?, match_status='auto' WHERE party_id=?", (bh[0], pid)); auto_h += 1
    for prop in props:
        if jacc(dname, prop[1]) >= 0.6:
            db.execute("""INSERT OR IGNORE INTO party_properties(party_id,property_id,confidence,source)
                          VALUES(?,?,?,'auto_name_match')""", (pid, prop[0], round(jacc(dname, prop[1]), 2)))
            auto_p += 1
note(f"auto-linked: {auto_h} parties→host, {auto_p} parties→property  (rest need your confirmation)")

# ---- flags ------------------------------------------------------------
f = 0
def flag(tid, ft, sev, msg):
    global f
    db.execute("INSERT INTO data_flags(txn_id,flag_type,severity,message) VALUES(?,?,?,?)", (tid, ft, sev, msg)); f += 1

seen = collections.defaultdict(list)
for tid, d, a, pid in db.execute("SELECT txn_id,txn_date,gross_amount,party_id FROM transactions"):
    seen[(d, round(a, 2), pid)].append(tid)
for k, ids in seen.items():
    if len(ids) > 1:
        for tid in ids: flag(tid, "possible_duplicate", "high",
            f"{len(ids)} entries share date {k[0]} / amount {k[1]:,.0f} / same party")
for tid, g, tx, cg, sg, ig in db.execute(
        "SELECT txn_id,gross_amount,taxable_value,cgst,sgst,igst FROM transactions WHERE (cgst+sgst+igst)>0"):
    if tx and abs((tx + cg + sg + ig) - g) > max(2.0, g * 0.01):
        flag(tid, "gst_mismatch", "medium", f"taxable {tx:,.0f} + GST {cg+sg+ig:,.0f} != gross {g:,.0f}")
for (tid,) in db.execute("SELECT txn_id FROM transactions WHERE party_id IS NULL"):
    flag(tid, "no_party", "medium", "no counterparty — cannot be attributed to a property or host")
for (tid,) in db.execute("SELECT txn_id FROM transactions WHERE voucher_type='Journal'"):
    flag(tid, "needs_classification", "medium", "journal entry — confirm the category")
note(f"flags raised: {f}")

db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('built_at',datetime('now'))")
db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('schema_version','1')")
db.execute("INSERT INTO audit_log(action,table_name,note) VALUES('import','*',?)", ("; ".join(log),))
db.commit()
note(f"\n==> {OUT}  ({os.path.getsize(OUT)/1024:.0f} KB)")
