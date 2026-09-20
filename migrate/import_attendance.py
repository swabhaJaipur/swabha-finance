#!/usr/bin/env python3
"""Attendance is a matrix: dates down the rows, employee names across the columns,
with P / A marks in the cells. Read it as such and total per person per month."""
import sqlite3, sys, os, re, datetime, unicodedata, collections
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
SRC=os.path.expanduser("~/Downloads/Attendance sheet.xlsx")
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row

def norm(s):
    s=unicodedata.normalize('NFKD',str(s or '')).lower()
    return re.sub(r'[^a-z0-9]+',' ',s).strip()
def sd(n):
    try:
        v=float(n)
        if v<30000 or v>60000: return None
        return (datetime.date(1899,12,30)+datetime.timedelta(days=int(v))).isoformat()
    except: return None

STAFF={norm(r['name']):r['cleaner_id'] for r in db.execute("SELECT cleaner_id,name FROM cleaners")}
FIRST=collections.defaultdict(list)
for k,v in STAFF.items():
    t=k.split()
    if t: FIRST[t[0]].append(v)
def match(nm):
    k=norm(nm)
    if not k: return None
    if k in STAFF: return STAFF[k]
    t=k.split()
    if t and len(FIRST.get(t[0],[]))==1: return FIRST[t[0]][0]
    for kk,v in STAFF.items():
        a,bb=set(kk.split()),set(t)
        if a and bb and (a<=bb or bb<=a): return v
    return None

NOT_NAME={'date','day','months','month','comment','verify by ridhika','verify by','total',
          'remark','remarks','sr','s no','sno'}
DATE_HDR={'date','months','month'}
db.execute("DELETE FROM attendance")
b=Book(SRC); sh=dict(b.sheets)
rows=0; people=set(); months=set(); unmatched=collections.Counter()
for sheet,tgt in b.sheets:
    rs=b.rows(tgt)
    # the header cell is 'DATE' on some sheets and 'Months ' on others
    hi=next((i for i,r in enumerate(rs[:10])
             if r and any(str(c).strip().lower() in DATE_HDR for c in r if c)), None)
    if hi is None: continue
    hdr=[str(c).strip() if c else '' for c in rs[hi]]
    cols=[(i,h) for i,h in enumerate(hdr)
          if h and norm(h) not in NOT_NAME and not norm(h).startswith('verify')]
    tally=collections.defaultdict(lambda: {'p':0,'a':0,'h':0,'days':0})
    month=None
    for r in rs[hi+1:]:
        if not any(r): continue
        r=r+[None]*(len(hdr)-len(r))
        d=sd(r[0])
        if not d: continue
        month = month or d[:7]
        for i,h in cols:
            v=str(r[i] or '').strip().upper()
            if not v or v=='-': continue
            e=tally[h]; e['days']+=1
            # 'Late' means they turned up — it counts as present, not absent
            if v.startswith('P') or v.startswith('L'): e['p']+=1
            elif v.startswith('A'): e['a']+=1
            elif 'HOLIDAY' in v or v.startswith('H'): e['h']+=1
    if not month: continue
    months.add(month)
    for h,e in tally.items():
        if not e['days']: continue
        cid=match(h)
        if not cid: unmatched[h]+=1
        people.add(h)
        try:
            db.execute("""INSERT INTO attendance(month,cleaner_id,staff_name,present,absent,
                          leave_days,total_days,src) VALUES(?,?,?,?,?,?,?,?)""",
              (month,cid,h.strip(),e['p'],e['a'],e['h'],e['days'],
               f"Attendance sheet.xlsx|{sheet}"))
            rows+=1
        except sqlite3.IntegrityError: pass
db.commit()
linked=db.execute("SELECT count(*) n FROM attendance WHERE cleaner_id IS NOT NULL").fetchone()['n']
print(f"attendance rebuilt: {rows} person-months across {len(months)} months, {len(people)} distinct names")
print(f"  linked to an employee record : {linked}")
print(f"  NOT linked                   : {rows-linked}")
if unmatched:
    print(f"  names with no employee record: {', '.join(sorted(unmatched))}")
print()
print("  per-person totals (present days across all months):")
for r in db.execute("""SELECT staff_name, count(*) months, sum(present) p, sum(absent) a,
                         max(CASE WHEN cleaner_id IS NULL THEN 1 ELSE 0 END) unl
                       FROM attendance GROUP BY 1 ORDER BY p DESC"""):
    print(f"    {r['staff_name'][:22]:24} {r['months']:>2} months  present {int(r['p'] or 0):>4}  absent {int(r['a'] or 0):>3}"
          + ("   << no employee record" if r['unl'] else ""))
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('system','attendance','import',?)",
  (f"attendance matrix re-read: {rows} person-months, {linked} linked",))
db.commit()
