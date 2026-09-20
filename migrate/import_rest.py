#!/usr/bin/env python3
"""The remaining sources: per-host laundry rates, attendance, the other salary books,
and the purchase item list. Everything keeps its file/sheet/row."""
import sqlite3, sys, os, re, datetime, collections, unicodedata
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
D=os.path.expanduser("~/Downloads/")
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row

def f(v):
    try: return float(str(v).replace(',','').replace('₹','').strip())
    except: return 0.0
def sd(n):
    try:
        v=float(n)
        if v<30000 or v>60000: return None
        return (datetime.date(1899,12,30)+datetime.timedelta(days=int(v))).isoformat()
    except: return None
def norm(s):
    s=unicodedata.normalize('NFKD',str(s or '')).lower()
    return re.sub(r'[^a-z0-9]+',' ',s).strip()
def squash(s): return norm(s).replace(' ','')
PARTY={r['display_name']:r['party_id'] for r in db.execute("SELECT party_id,display_name FROM parties")}
PSQ={squash(k):v for k,v in PARTY.items()}
def find_party(n):
    if not n: return None
    if n in PARTY: return PARTY[n]
    s=squash(n)
    if s in PSQ: return PSQ[s]
    for k,v in PSQ.items():
        if k and s and (k in s or s in k) and min(len(k),len(s))>=6: return v
    return None

out=[]
def say(k,v): out.append((k,v)); print(f"  {k:46} {v}")

# ------------------------------------------------ 1. per-host laundry rates
try:
    b=Book(D+"Laundry Rates.xlsx")
    db.execute("DELETE FROM party_rate_override WHERE notes LIKE 'Laundry Rates.xlsx%'")
    n=0; hosts=set(); unmatched=[]
    for sheet,tgt in b.sheets:
        rs=b.rows(tgt)
        if not rs: continue
        # find the row that looks like a header: has a 'rate' cell
        hi=None
        for i,r in enumerate(rs[:12]):
            cells=[str(c).strip().lower() for c in r if c]
            if any(c=='rate' for c in cells) and any('laundry' in c or 'service' in c for c in cells):
                hi=i; break
        if hi is None: continue
        hdr=[str(c).strip() if c else '' for c in rs[hi]]
        li=next((i for i,h in enumerate(hdr) if 'laundry' in h.lower() or 'service' in h.lower()), None)
        ri=next((i for i,h in enumerate(hdr) if h.strip().lower()=='rate'), None)
        if li is None or ri is None: continue
        # the host is either the sheet name or a label above the header
        host=sheet.strip()
        for j in range(max(0,hi-3),hi):
            a=[str(c).strip() for c in rs[j] if c]
            if len(a)==1 and len(a[0])>4 and 'rate' not in a[0].lower(): host=a[0]
        pid=find_party(host)
        if not pid: unmatched.append(host)
        for rownum,r in enumerate(rs[hi+1:], start=hi+2):
            if not any(r): continue
            r=r+[None]*(len(hdr)-len(r))
            item=str(r[li] or '').strip(); rate=f(r[ri])
            if not item or len(item)<4 or rate<=0: continue
            item=re.sub(r'^SLS\s*:?-?\s*','',item, flags=re.I).strip()
            db.execute("""INSERT INTO party_rate_override(party_id,party_name,service,item,base_rate,
                          gst_rate,valid_from,notes) VALUES(?,?,'laundry',?,?,18,'2025-04-01',?)""",
              (pid, host, item, rate, f"Laundry Rates.xlsx | sheet '{sheet}' row {rownum}"))
            n+=1; hosts.add(host)
    db.commit()
    say("per-host laundry rates", f"{n} rates across {len(hosts)} hosts ({len(set(unmatched))} host names not yet linked)")
except Exception as e: say("laundry rates FAILED", str(e)[:70])

# ------------------------------------------------ 2. attendance
try:
    db.execute("""CREATE TABLE IF NOT EXISTS attendance(
        att_id INTEGER PRIMARY KEY, month TEXT, cleaner_id INTEGER REFERENCES cleaners(cleaner_id),
        staff_name TEXT, present REAL, absent REAL, leave_days REAL, total_days REAL,
        src TEXT, UNIQUE(month, staff_name))""")
    b=Book(D+"Attendance sheet.xlsx")
    CLEAN={norm(r['name']):r['cleaner_id'] for r in db.execute("SELECT cleaner_id,name FROM cleaners")}
    def find_staff(nm):
        k=norm(nm)
        if k in CLEAN: return CLEAN[k]
        t=k.split()
        for kk,v in CLEAN.items():
            if t and kk.split() and t[0]==kk.split()[0]: return v
        return None
    MON={'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,'jul':7,'aug':8,'sep':9,'oct':10,'nov':11,'dec':12}
    n=0; months=set()
    for sheet,tgt in b.sheets:
        m=re.match(r'([a-z]{3,9})\s*\'?(\d{2,4})', sheet.strip().lower())
        if not m: continue
        mm=MON.get(m.group(1)[:3]);  yy=int(m.group(2)); yy = yy+2000 if yy<100 else yy
        if not mm: continue
        month=f"{yy}-{mm:02d}"; months.add(month)
        rs=b.rows(tgt)
        hi=next((i for i,r in enumerate(rs[:15]) if r and any('name' in str(c).lower() for c in r if c)), 0)
        hdr=[str(c).strip() if c else '' for c in rs[hi]]
        ni=next((i for i,h in enumerate(hdr) if 'name' in h.lower()), 0)
        pi=next((i for i,h in enumerate(hdr) if h.strip().lower() in ('present','p','total present','working days')), None)
        ai=next((i for i,h in enumerate(hdr) if h.strip().lower() in ('absent','a','total absent')), None)
        for rownum,r in enumerate(rs[hi+1:], start=hi+2):
            if not any(r): continue
            r=r+[None]*(len(hdr)-len(r))
            nm=str(r[ni] or '').strip()
            if not nm or len(nm)<3 or nm.lower().startswith(('name','total','s.')): continue
            pres = f(r[pi]) if pi is not None else 0
            # otherwise count P / present marks across the row
            if not pres:
                pres=sum(1 for c in r if str(c).strip().upper() in ('P','PRESENT','1','1.0'))
            try:
                db.execute("""INSERT INTO attendance(month,cleaner_id,staff_name,present,absent,src)
                              VALUES(?,?,?,?,?,?)""",
                  (month, find_staff(nm), nm, pres, f(r[ai]) if ai is not None else 0,
                   f"Attendance sheet.xlsx|{sheet}|row{rownum}"))
                n+=1
            except sqlite3.IntegrityError: pass
    db.commit()
    say("attendance rows", f"{n} across {len(months)} months ({', '.join(sorted(months)[:4])}…)")
except Exception as e: say("attendance FAILED", str(e)[:70])

# ------------------------------------------------ 3. purchase item list
try:
    b=Book(D+"Purchase.xlsx"); sh=dict(b.sheets)
    db.execute("""CREATE TABLE IF NOT EXISTS supply_items(
        item_id INTEGER PRIMARY KEY, name TEXT UNIQUE, unit TEXT, rate REAL, rate_with_gst REAL, src TEXT)""")
    rs=b.rows(sh['Sheet2']); n=0
    for rownum,r in enumerate(rs[1:], start=2):
        if not any(r): continue
        r=r+[None]*6
        nm=str(r[1] or '').strip()
        if not nm or len(nm)<3: continue
        try:
            db.execute("INSERT INTO supply_items(name,rate,rate_with_gst,src) VALUES(?,?,?,?)",
                       (nm, f(r[3]) or None, f(r[4]) or None, f"Purchase.xlsx|Sheet2|row{rownum}"))
            n+=1
        except sqlite3.IntegrityError: pass
    db.commit()
    say("purchase item list", f"{n} items (the sheet is a blank PO template — no rates filled in, no transactions)")
except Exception as e: say("purchase items FAILED", str(e)[:70])

# ------------------------------------------------ 4. other salary workbooks
try:
    found=0; upd=0
    CLEAN={norm(r['name']):r['cleaner_id'] for r in db.execute("SELECT cleaner_id,name FROM cleaners")}
    for fn in ["Swabha Salary .xlsx","Swabha Salary Sheet.xlsx","Salary Structure .xlsx","Monthly Book.xlsx"]:
        try: b=Book(D+fn)
        except Exception: continue
        for sheet,tgt in b.sheets:
            rs=b.rows(tgt)
            hi=next((i for i,r in enumerate(rs[:12])
                     if r and any('name of employee' in str(c).lower() for c in r if c)), None)
            if hi is None: continue
            hdr=[str(c).strip() if c else '' for c in rs[hi]]
            ni=next((i for i,h in enumerate(hdr) if 'name of employee' in h.lower()), None)
            ci=next((i for i,h in enumerate(hdr) if h.strip().upper()=='CTC'), None)
            gi=next((i for i,h in enumerate(hdr) if 'salary in month' in h.lower()), None)
            if ni is None: continue
            seen=set()
            for r in rs[hi+1:]:
                if not any(r): continue
                r=r+[None]*(len(hdr)-len(r))
                nm=str(r[ni] or '').strip()
                if not nm or nm.lower().startswith('name'): continue
                if nm.lower() in seen: break
                seen.add(nm.lower())
                gross=f(r[gi]) if gi is not None else 0
                ctc=f(r[ci]) if ci is not None else 0
                if gross<3000 and ctc<3000: continue
                cid=CLEAN.get(norm(nm))
                if not cid:
                    t=norm(nm).split()
                    for kk,v in CLEAN.items():
                        if t and kk.split() and t[0]==kk.split()[0]: cid=v; break
                found+=1
                if cid:
                    db.execute("""UPDATE cleaners SET monthly_salary=coalesce(monthly_salary,?),
                                  employer_cost=coalesce(employer_cost,?) WHERE cleaner_id=?""",
                               (gross or None, ctc or gross or None, cid)); upd+=1
                else:
                    try:
                        db.execute("""INSERT INTO cleaners(name,pay_type,monthly_salary,employer_cost,active,notes)
                                      VALUES(?,'monthly_salary',?,?,0,?)""",
                                   (nm, gross or None, ctc or gross or None, f"from {fn}"))
                        CLEAN[norm(nm)]=db.execute("SELECT last_insert_rowid() i").fetchone()['i']
                    except sqlite3.IntegrityError: pass
    db.commit()
    say("other salary books", f"{found} salary rows read, {upd} matched to existing staff")
except Exception as e: say("other salary FAILED", str(e)[:70])

print()
t=db.execute("SELECT count(*) n FROM transactions").fetchone()['n']
ov=db.execute("SELECT count(*) n FROM party_rate_override").fetchone()['n']
at=db.execute("SELECT count(*) n FROM attendance").fetchone()['n']
st=db.execute("SELECT count(*) n FROM cleaners WHERE employer_cost>0").fetchone()['n']
print(f"  ledger {t} | rate overrides {ov} | attendance {at} | staff with CTC {st}")
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('system','*','import',?)",
  ("remaining sources: "+"; ".join(f"{k}={v}" for k,v in out),))
db.commit()
