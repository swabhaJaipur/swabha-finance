#!/usr/bin/env python3
"""Push every remaining source into the database.
Nothing is dropped. Anything that looks like a duplicate is IMPORTED AND FLAGGED so the
owner decides, never the importer. Every row keeps its file, sheet and row number."""
import sqlite3, sys, os, re, datetime, hashlib, collections, unicodedata
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
D=os.path.expanduser("~/Downloads/")
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")

def f(v):
    try: return float(str(v).replace(',','').replace('₹','').strip())
    except: return 0.0
def sd(n):
    try:
        v=float(n)
        if v<30000 or v>60000: return None
        return (datetime.date(1899,12,30)+datetime.timedelta(days=int(v))).isoformat()
    except: return None
def pdate(s):
    if s in (None,''): return None
    s=str(s).strip()
    d=sd(s)
    if d: return d
    for fmt in ("%Y-%m-%d","%d-%b-%Y","%d/%m/%Y","%d-%m-%Y","%d %b %Y","%b %d, %Y","%d.%m.%Y"):
        try: return datetime.datetime.strptime(s,fmt).date().isoformat()
        except: pass
    m=re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$",s)
    if m: return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None
def norm(s):
    s=unicodedata.normalize('NFKD',str(s or '')).lower()
    s=re.sub(r'\b(pvt|private|limited|ltd|llp|the|and|co|company)\b',' ',s)
    return re.sub(r'[^a-z0-9]+',' ',s).strip()
def squash(s): return norm(s).replace(' ','')

def table(bk, sheet, minc=3):
    sh=dict(bk.sheets)
    if sheet not in sh: return []
    rs=bk.rows(sh[sheet])
    hi=next((i for i,r in enumerate(rs) if sum(1 for c in r if c)>=minc),None)
    if hi is None: return []
    hdr=[str(c).strip() if c else '' for c in rs[hi]]
    out=[]
    for n,r in enumerate(rs[hi+1:], start=hi+2):
        if not any(r): continue
        r=r+[None]*(len(hdr)-len(r))
        d={k:r[i] for i,k in enumerate(hdr) if k}
        d['__row']=n
        out.append(d)
    return out

# ---- lookups -------------------------------------------------------------
PARTY={r['display_name']:r['party_id'] for r in db.execute("SELECT party_id,display_name FROM parties")}
PSQ={squash(k):v for k,v in PARTY.items()}
CAT={r['name']:r['category_id'] for r in db.execute("SELECT category_id,name FROM categories")}
def party_id(name, create=True):
    if not name: return None
    n=str(name).strip()
    if n in PARTY: return PARTY[n]
    s=squash(n)
    if s in PSQ: return PSQ[s]
    if not create: return None
    c=db.execute("INSERT INTO parties(display_name,tally_name,match_status) VALUES(?,?,'unmapped')",(n,n))
    PARTY[n]=c.lastrowid; PSQ[s]=c.lastrowid
    return c.lastrowid

def flag(txn_id, kind, sev, msg):
    db.execute("INSERT INTO data_flags(txn_id,flag_type,severity,message) VALUES(?,?,?,?)",
               (txn_id,kind,sev,msg))

def near_bank(date, amount, direction):
    """does a bank row already show this payment?"""
    col='debit' if direction=='out' else 'credit'
    r=db.execute(f"""SELECT bt_id,txn_date,{col} amt FROM bank_transactions
        WHERE {col}>0 AND abs({col}-?)<=max(2,?*0.02)
          AND abs(julianday(txn_date)-julianday(?))<=4 LIMIT 1""",(amount,amount,date)).fetchone()
    return r
def near_ledger(date, amount, direction):
    r=db.execute("""SELECT txn_id,txn_date FROM transactions
        WHERE direction=? AND status='Posted' AND abs(gross_amount-?)<=max(2,?*0.02)
          AND abs(julianday(txn_date)-julianday(?))<=4 LIMIT 1""",(direction,amount,amount,date)).fetchone()
    return r

def post(date, direction, amount, category, party, narration, source, src_ref, month=None,
         gst=0.0, compliance='unknown', voucher=None, review=1):
    if not date or not amount: return None
    y,m=int(date[:4]),int(date[5:7])
    cid=CAT.get(category) or CAT['Unclassified']
    c=db.execute("""INSERT INTO transactions(voucher_no,voucher_type,txn_date,fy,month,direction,
        party_id,category_id,gross_amount,cgst,sgst,gst_treatment,status,narration,source,source_ref,
        compliance,in_tally,needs_review)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'Posted',?,?,?,?,0,?)""",
      (voucher, source, date, f"{y}-{y+1}" if m>=4 else f"{y-1}-{y}", date[:7], direction,
       party_id(party) if party else None, cid, abs(amount), gst/2, gst/2,
       'inclusive' if gst else 'none', str(narration or '')[:400], source, src_ref, compliance, review))
    return c.lastrowid

report=collections.OrderedDict()
def say(k,v): report[k]=v; print(f"  {k:44} {v}")

print("="*78); print("PUSHING ALL REMAINING SOURCES"); print("="*78)

# ---------------------------------------------------------------- 1. chat payments
try:
    bk=Book(D+"Swabha_Chat_Payments_Invoices.xlsx")
    rows=table(bk,'Payments')
    n=dup=0
    for r in rows:
        date=pdate(r.get('Payment date as shown')) or sd(r.get('Chat date'))
        amt=f(r.get('Amount (INR)'))
        if not date or not amt: continue
        ben=str(r.get('Beneficiary') or '').strip()
        # money to Swabha = in; money to anyone else = out
        direction='in' if squash(ben).startswith('swabha') else 'out'
        tid=post(date,direction,amt,'Service Revenue' if direction=='in' else 'Unclassified',
                 ben or None, f"{r.get('Chat sender','')}: {r.get('Filename','')}",
                 'Chat Extract', f"{r.get('Source ID')}|row{r['__row']}")
        if tid:
            n+=1
            b=near_bank(date,amt,direction)
            if b:
                dup+=1
                flag(tid,'possible_duplicate','high',
                     f"also appears in the bank statement on {b['txn_date']} for Rs {b['amt']:,.0f} (bank row {b['bt_id']}) — keep one")
            l=near_ledger(date,amt,direction)
            if l: flag(tid,'possible_duplicate','medium',
                       f"similar Tally entry {l['txn_id']} on {l['txn_date']}")
    db.commit(); say("chat Payments imported", f"{n} (flagged as possible bank duplicates: {dup})")
except Exception as e: say("chat Payments FAILED", str(e)[:70])

# ---------------------------------------------------------------- 2. chat invoices
try:
    rows=table(bk,'Invoices')
    n=dup=0
    for r in rows:
        date=pdate(r.get('Invoice date'))
        amt=f(r.get('Total (INR)'))
        if not date or not amt: continue
        seller=str(r.get('Seller') or '')
        buyer=str(r.get('Buyer / host') or '')
        is_sale = squash(seller).startswith('swabha')
        gst=f(r.get('CGST (INR)'))+f(r.get('SGST (INR)'))+f(r.get('IGST (INR)'))
        tid=post(date,'in' if is_sale else 'out',amt,
                 'Service Revenue' if is_sale else 'Supplier Purchases',
                 (buyer if is_sale else seller) or None,
                 f"{r.get('Document type','')} {r.get('Invoice number','')}".strip(),
                 'Chat Extract', f"{r.get('Source ID')}|row{r['__row']}",
                 gst=gst, compliance='gst' if gst else 'non_gst',
                 voucher=str(r.get('Invoice number') or '') or None)
        if tid:
            n+=1
            l=near_ledger(date,amt,'in' if is_sale else 'out')
            if l:
                dup+=1
                flag(tid,'possible_duplicate','high',
                     f"likely the same as Tally entry {l['txn_id']} dated {l['txn_date']} — keep one")
    db.commit(); say("chat Invoices imported", f"{n} (flagged vs Tally: {dup})")
except Exception as e: say("chat Invoices FAILED", str(e)[:70])

# ---------------------------------------------------------------- 3. host balances -> invoices
try:
    rows=table(bk,'Host Balances')
    # several snapshots of the same month exist; keep them all but mark the newest per month
    bysnap=collections.defaultdict(list)
    for r in rows: bysnap[(sd(r.get('Chat date')) or '')[:7]].append(r)
    db.execute("DELETE FROM invoices WHERE source='host_balances'")
    n=0; latest=0
    for month,rs in bysnap.items():
        files=sorted({str(x.get('Filename') or '') for x in rs})
        newest=files[-1] if files else None
        for r in rs:
            pn=str(r.get('Host / party') or '').strip()
            if not pn or f(pn) or len(pn)<3: continue          # junk rows like '28500'
            tot=f(r.get('Total (INR)'))
            if not tot: continue
            is_new = str(r.get('Filename') or '')==newest
            if is_new: latest+=1
            db.execute("""INSERT INTO invoices(party_id,period,cleaning,laundry,total,received,status,
                          source,notes) VALUES(?,?,?,?,?,?,?,'host_balances',?)""",
              (party_id(pn), month, f(r.get('Cleaning (INR)')), f(r.get('Laundry (INR)')), tot,
               f(r.get('Receipt (INR)')),
               'open' if f(r.get('Closing balance (INR)'))>0 else 'paid',
               ('LATEST snapshot for '+month if is_new else 'earlier snapshot — superseded')
               + f" | {r.get('Filename')}"))
            n+=1
    db.commit(); say("Host Balances imported", f"{n} rows ({latest} in the latest snapshot per month)")
except Exception as e: say("Host Balances FAILED", str(e)[:70])

# ---------------------------------------------------------------- 4. sundry debtors
try:
    b2=Book(D+"Swabha Sundry Debtors.xlsx")
    n=0
    for sheet in ['Sheet1','Sheet2']:
        for r in table(b2,sheet):
            pn=str(r.get('Particulars') or '').strip()
            tot=f(r.get('TOTAL'))
            if not pn or not tot or pn.lower().startswith('sundry'): continue
            db.execute("""INSERT INTO invoices(party_id,period,cleaning,total,received,status,source,notes)
                          VALUES(?,?,?,?,0,'open','sundry_debtors',?)""",
              (party_id(pn), None, f(r.get('Cleaning')), tot,
               f"GSTIN {r.get('GSTIN') or '-'} | {sheet} row {r['__row']}"))
            if r.get('GSTIN'):
                db.execute("UPDATE parties SET gstin=coalesce(nullif(gstin,''),?) WHERE party_id=?",
                           (str(r.get('GSTIN')), party_id(pn)))
            n+=1
    db.commit(); say("Sundry Debtors imported", f"{n} receivable rows")
except Exception as e: say("Sundry Debtors FAILED", str(e)[:70])

# ---------------------------------------------------------------- 5. purchases
try:
    b3=Book(D+"Purchase.xlsx")
    n=dup=0
    for sheet in [s for s,_ in b3.sheets]:
        for r in table(b3,sheet):
            keys={k.lower():k for k in r if isinstance(k,str)}
            dk=next((keys[k] for k in keys if 'date' in k),None)
            ak=next((keys[k] for k in keys if k in ('amount','total','value','net amount','grand total')),None)
            pk=next((keys[k] for k in keys if 'party' in k or 'supplier' in k or 'vendor' in k or 'particular' in k),None)
            if not dk or not ak: continue
            date=pdate(r.get(dk)); amt=f(r.get(ak))
            if not date or not amt: continue
            tid=post(date,'out',amt,'Supplier Purchases', r.get(pk) if pk else None,
                     f"purchase {sheet} row {r['__row']}", 'Purchase Sheet',
                     f"Purchase.xlsx|{sheet}|row{r['__row']}")
            if tid:
                n+=1
                l=near_ledger(date,amt,'out')
                if l: dup+=1; flag(tid,'possible_duplicate','high',
                                   f"similar Tally purchase {l['txn_id']} on {l['txn_date']}")
    db.commit(); say("Purchases imported", f"{n} (flagged vs Tally: {dup})")
except Exception as e: say("Purchases FAILED", str(e)[:70])

# ---------------------------------------------------------------- 6. petty cash ledger
try:
    b4=Book(D+"Customer_All_Transactions_Report__01 Feb 2026_to_31 Aug 2026.xlsx")
    n=0
    for r in table(b4,'transactions'):
        date=pdate(r.get('Date'))
        dr=f(r.get('Debit(-)')); cr=f(r.get('Credit(+)'))
        if not date or (not dr and not cr): continue
        tid=post(date,'out' if dr else 'in', dr or cr,
                 'Miscellaneous' if dr else 'Service Revenue',
                 None, r.get('Details'), 'Petty Cash', f"petty|row{r['__row']}")
        if tid: n+=1
    db.commit(); say("Petty cash ledger imported", f"{n} entries")
except Exception as e: say("Petty cash FAILED", str(e)[:70])

# ---------------------------------------------------------------- 7. laundry rates per host
try:
    b5=Book(D+"Laundry Rates.xlsx")
    n=0
    for sheet,_ in b5.sheets:
        rows=table(b5,sheet,2)
        for r in rows:
            keys={str(k).lower():k for k in r if isinstance(k,str)}
            ik=next((keys[k] for k in keys if 'item' in k or 'particular' in k or 'linen' in k),None)
            rk=next((keys[k] for k in keys if k.strip() in ('rate','price','amount')),None)
            if not ik or not rk: continue
            item=str(r.get(ik) or '').strip(); rate=f(r.get(rk))
            if not item or not rate or len(item)<3: continue
            db.execute("""INSERT INTO party_rate_override(party_name,service,item,base_rate,gst_rate,
                          valid_from,notes) VALUES(?,'laundry',?,?,18,'2025-04-01',?)""",
              (sheet.strip(), item, rate, f"Laundry Rates.xlsx sheet '{sheet}' row {r['__row']}"))
            n+=1
    db.commit(); say("Per-host laundry rates imported", f"{n} overrides")
except Exception as e: say("Laundry rates FAILED", str(e)[:70])

# ---------------------------------------------------------------- 8. inventory
try:
    b6=Book(D+"Inventory.xlsx")
    db.execute("""CREATE TABLE IF NOT EXISTS inventory_moves(
        inv_id INTEGER PRIMARY KEY, move_date TEXT, direction TEXT, item TEXT,
        qty REAL, rate REAL, amount REAL, property_id TEXT, party TEXT, src TEXT)""")
    n=0
    for sheet,kind in [('Inward','in'),('Outward','out')]:
        for r in table(b6,sheet,2):
            keys={str(k).lower():k for k in r if isinstance(k,str)}
            ik=next((keys[k] for k in keys if 'item' in k or 'product' in k),None)
            qk=next((keys[k] for k in keys if 'qty' in k or 'quantity' in k),None)
            if not ik: continue
            item=str(r.get(ik) or '').strip()
            if not item or len(item)<2: continue
            dk=next((keys[k] for k in keys if 'date' in k),None)
            db.execute("""INSERT INTO inventory_moves(move_date,direction,item,qty,src)
                          VALUES(?,?,?,?,?)""",
              (pdate(r.get(dk)) if dk else None, kind, item, f(r.get(qk)) if qk else 0,
               f"Inventory.xlsx|{sheet}|row{r['__row']}"))
            n+=1
    db.commit(); say("Inventory movements imported", f"{n}")
except Exception as e: say("Inventory FAILED", str(e)[:70])

# ---------------------------------------------------------------- summary
print()
t=db.execute("""SELECT count(*) n,
   sum(CASE WHEN in_tally=1 THEN 1 ELSE 0 END) tally,
   sum(CASE WHEN coalesce(in_tally,1)=0 THEN 1 ELSE 0 END) nontally,
   sum(CASE WHEN needs_review=1 THEN 1 ELSE 0 END) review FROM transactions""").fetchone()
fl=db.execute("SELECT count(*) n FROM data_flags WHERE resolved=0").fetchone()
inv=db.execute("SELECT count(*) n, coalesce(sum(total-received),0) v FROM invoices").fetchone()
print("="*78)
print(f"  ledger total      : {t['n']} entries  ({t['tally']} in Tally, {t['nontally']} not in Tally)")
print(f"  needing review    : {t['review']}")
print(f"  open flags        : {fl['n']}")
print(f"  receivable rows   : {inv['n']}  outstanding Rs {inv['v']:,.0f}")
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('system','*','import',?)",
  ("bulk import: "+"; ".join(f"{k}={v}" for k,v in report.items()),))
db.commit()
