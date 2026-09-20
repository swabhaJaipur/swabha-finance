#!/usr/bin/env python3
"""Load employee salary structures. Stores CTC (employer cost) not net pay, so
margins never quietly omit PF and ESIC."""
import sqlite3, sys, os, re, unicodedata
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
SRC=os.path.expanduser("~/Downloads/Employee's Salary .xlsx")
def f(v):
    try: return float(str(v).replace(',',''))
    except: return 0.0
def norm(s): return re.sub(r'[^a-z ]+',' ',unicodedata.normalize('NFKD',str(s or '')).lower()).strip()

db=sqlite3.connect(DB)
b=Book(SRC); sh=dict(b.sheets)
# 'Sheet 1' is the consolidated roll with Net Payable and CTC
rs=b.rows(sh['Sheet 1']); hdr=[str(c).strip() if c else '' for c in rs[0]]
idx={h:i for i,h in enumerate(hdr) if h}
people=[]
seen=set()
for r in rs[1:]:
    if not any(r): continue
    r=r+[None]*(len(hdr)-len(r))
    name=str(r[idx.get('Name Of Employee',1)] or '').strip()
    if not name or name.lower().startswith('name'): continue
    # the sheet stacks several tables with different columns; stop at the first repeat
    # so PF/ESIC blocks further down cannot overwrite the salary block
    key=name.strip().lower()
    if key in seen: break
    seen.add(key)
    people.append({'name':name,'gross':f(r[idx.get('Salary in Month',2)]),
      'basic':f(r[idx.get('Basic salary',3)]),'hra':f(r[idx.get('HRA',4)]),
      'other':f(r[idx.get('Other allowances',5)]),
      'net':f(r[idx.get('Net Payable',6)]),'ctc':f(r[idx.get('CTC',7)])})
rows=[(r[0], r[1]) for r in db.execute("SELECT cleaner_id,name FROM cleaners")]
exact={r[1].strip().lower():r[0] for r in rows}
normed={norm(r[1]):r[0] for r in rows}
# payroll writes "ARUN" where the roster says "Arun  Kumar" — match on first name too
firsts={}
for cid,nm in rows:
    t=norm(nm).split()
    if t: firsts.setdefault(t[0], []).append(cid)
def find(name):
    k=name.strip().lower()
    if k in exact: return exact[k]
    n=norm(name)
    if n in normed: return normed[n]
    t=n.split()
    if t and len(firsts.get(t[0],[]))==1: return firsts[t[0]][0]
    for cid,nm in rows:
        a,bn=set(norm(nm).split()), set(t)
        if a and bn and (a<=bn or bn<=a): return cid
    return None
made=upd=0
for p in people:
    if p['gross']<=0 and p['ctc']<=0: continue
    if p['gross'] and p['gross']<3000: continue   # a PF/ESIC figure, not a salary
    cid=find(p['name'])
    ctc=p['ctc'] or p['gross']
    if cid:
        db.execute("""UPDATE cleaners SET monthly_salary=?, employer_cost=?, pay_type='monthly_salary'
                      WHERE cleaner_id=?""",(p['gross'] or p['net'], ctc, cid)); upd+=1
    else:
        try:
            db.execute("""INSERT INTO cleaners(name,pay_type,monthly_salary,employer_cost,active,notes)
                          VALUES(?,'monthly_salary',?,?,0,'from Employee Salary sheet')""",
                       (p['name'], p['gross'] or p['net'], ctc)); made+=1
        except sqlite3.IntegrityError:
            db.execute("""UPDATE cleaners SET monthly_salary=?, employer_cost=?,
                          pay_type='monthly_salary' WHERE lower(name)=lower(?)""",
                       (p['gross'] or p['net'], ctc, p['name'])); upd+=1
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('system','cleaners','import',?)",
           (f"salary structures loaded: {upd} matched, {made} new, from Employee's Salary.xlsx",))
db.commit()
print(f"salary rows read: {len(people)}")
print(f"  matched to existing staff : {upd}")
print(f"  added as new staff        : {made}")
tot=db.execute("SELECT count(*) n, sum(employer_cost) c FROM cleaners WHERE employer_cost>0").fetchone()
print(f"  staff with a CTC now      : {tot[0]}  totalling Rs {tot[1]:,.0f}/month")
for r in db.execute("SELECT name, monthly_salary, employer_cost, active FROM cleaners WHERE employer_cost>0 ORDER BY employer_cost DESC LIMIT 10"):
    print(f"     {r[0][:26]:28} salary {r[1]:>9,.0f}  CTC {r[2]:>9,.0f}  {'current' if r[3] else 'former'}")
