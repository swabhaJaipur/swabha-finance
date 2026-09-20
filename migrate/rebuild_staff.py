#!/usr/bin/env python3
"""The attendance sheet is the authority on who worked here and when.
Rebuild the employee master from it: every name becomes an employee, tenure runs from
the first month they appear to the last, and salary is attached where a sheet matches."""
import sqlite3, sys, os, re, unicodedata, collections
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row

def norm(s):
    s=unicodedata.normalize('NFKD',str(s or '')).lower()
    s=re.sub(r'\(.*?\)',' ',s)                       # drop "(1 sep )", "(not joined )"
    return re.sub(r'[^a-z0-9]+',' ',s).strip()

# ---- 1. who appears in attendance, and over which months -------------------
att=collections.defaultdict(lambda: {'months':set(),'present':0,'absent':0,'holiday':0,
                                     'days':0,'labels':set()})
for r in db.execute("""SELECT staff_name, month, present, absent, leave_days, total_days
                       FROM attendance"""):
    k=norm(r['staff_name'])
    if not k: continue
    e=att[k]
    e['months'].add(r['month']); e['labels'].add(r['staff_name'].strip())
    e['present']+=r['present'] or 0; e['absent']+=r['absent'] or 0
    e['holiday']+=r['leave_days'] or 0; e['days']+=r['total_days'] or 0
if not att:
    sys.exit("no attendance rows — run import_attendance.py first")
ALL_MONTHS=sorted({m for e in att.values() for m in e['months']})
LATEST=ALL_MONTHS[-1]
print(f"attendance covers {ALL_MONTHS[0]} -> {LATEST} ({len(ALL_MONTHS)} months), {len(att)} distinct people")

# ---- 2. salary already loaded, keyed by normalised name --------------------
sal={}
for r in db.execute("SELECT cleaner_id,name,monthly_salary,employer_cost,on_roll FROM cleaners"):
    k=norm(r['name'])
    if not k: continue
    # keep the record that actually carries money
    if k not in sal or (r['employer_cost'] or 0) > (sal[k]['employer_cost'] or 0):
        sal[k]=r
FIRST=collections.defaultdict(list)
for k,v in sal.items():
    t=k.split()
    if t: FIRST[t[0]].append(v)
def find_salary(k):
    if k in sal: return sal[k]
    t=k.split()
    if t and len(FIRST.get(t[0],[]))==1: return FIRST[t[0]][0]
    for kk,v in sal.items():
        a,b=set(kk.split()),set(t)
        if a and b and (a<=b or b<=a): return v
    return None

# ---- 3. rebuild ------------------------------------------------------------
created=updated=0; rows=[]
for k,e in sorted(att.items(), key=lambda x:-x[1]['present']):
    months=sorted(e['months'])
    joined, left = months[0], months[-1]
    active = 1 if left==LATEST else 0
    # prefer the longest written form of the name as the display name
    label=sorted(e['labels'], key=lambda s:(-len(s), s))[0]
    sr=find_salary(k)
    cid = sr['cleaner_id'] if sr else None
    if cid:
        db.execute("""UPDATE cleaners SET name=?, active=?, joined_month=?, exit_month=?,
                      source_of_truth='attendance sheet',
                      notes=? WHERE cleaner_id=?""",
          (label, active, joined, None if active else left,
           f"tenure from attendance {joined}..{left}; {int(e['present'])} days present",
           cid)); updated+=1
    else:
        cur=db.execute("""INSERT INTO cleaners(name,pay_type,active,on_roll,joined_month,exit_month,
                          source_of_truth,notes) VALUES(?,'monthly_salary',?,1,?,?,'attendance sheet',?)""",
          (label, active, joined, None if active else left,
           f"created from attendance {joined}..{left}; {int(e['present'])} days present; SALARY NOT FOUND"))
        cid=cur.lastrowid; created+=1
    rows.append((label, cid, joined, left, active, int(e['present']), int(e['absent']),
                 len(months), (sr['monthly_salary'] if sr else None), (sr['employer_cost'] if sr else None)))
    # attach every attendance row to this employee
    for lb in e['labels']:
        db.execute("UPDATE attendance SET cleaner_id=? WHERE staff_name=?", (cid, lb))

# ---- 4. anyone with salary but never in attendance -------------------------
attkeys=set(att.keys())
orphans=[]
for r in db.execute("""SELECT cleaner_id,name,monthly_salary,employer_cost FROM cleaners
                       WHERE source_of_truth IS NULL"""):
    if norm(r['name']) in attkeys: continue
    orphans.append(r)
    db.execute("""UPDATE cleaners SET active=0, source_of_truth='salary sheet only',
                  notes='not present in any attendance month — confirm' WHERE cleaner_id=?""",
               (r['cleaner_id'],))
db.commit()

unlinked=db.execute("SELECT count(*) n FROM attendance WHERE cleaner_id IS NULL").fetchone()['n']
print(f"employees created {created}, updated {updated}; attendance rows still unlinked: {unlinked}")
print(f"salary-only records with no attendance: {len(orphans)}")
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('owner','cleaners','update',?)",
  (f"employee master rebuilt from the attendance sheet ({ALL_MONTHS[0]}..{LATEST}): "
   f"{created} created, {updated} updated, {len(orphans)} salary-only flagged",))
db.commit()

print()
print("  "+"name".ljust(22)+"joined   left     status   mo  present absent   salary      CTC")
for (label,cid,joined,left,active,pres,absn,nm,sal_,ctc) in rows:
    print("  "+label[:21].ljust(22)+joined.ljust(9)+("—".ljust(9) if active else left.ljust(9))
          +("CURRENT" if active else "left   ").ljust(9)+str(nm).rjust(3)+str(pres).rjust(8)+str(absn).rjust(7)
          +(f"{sal_:,.0f}" if sal_ else "—").rjust(10)+(f"{ctc:,.0f}" if ctc else "—").rjust(10))
if orphans:
    print()
    print("  SALARY ON RECORD BUT NEVER IN ATTENDANCE:")
    for o in orphans:
        print("    "+o['name'][:28].ljust(30)+(f"{o['monthly_salary']:,.0f}" if o['monthly_salary'] else '—').rjust(10))
