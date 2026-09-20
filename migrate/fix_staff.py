#!/usr/bin/env python3
"""Owner corrections 2026-09-20:
 - Ritesh / Ritesh pawar are one person; Om / Omprakash likewise; the Sana spellings likewise
 - Kiran and Gangotri joined today
 - staff with no ESIC/PF are paid in cash, not from the Swabha bank
 - December 2025 attendance is missing and must be visible as a gap, not silently absent"""
import sqlite3, sys, os, re, unicodedata
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
TODAY='2026-09-20'; THISMON='2026-09'

def one(sql,*a):
    r=db.execute(sql,a).fetchone(); return r
def say(m): print("  "+m)

# ---------- 1. merge the name variants -------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(HERE),'server'))
MERGES=[('Ritesh pawar','Ritesh'), ('Om','Omprakash'), ('SANA DI','Sana')]
for keep_name, merge_name in MERGES:
    k=one("SELECT cleaner_id,name FROM cleaners WHERE name=?",keep_name)
    m=one("SELECT cleaner_id,name FROM cleaners WHERE name=?",merge_name)
    if not k or not m:
        # the pair may already be one record
        continue
    # move everything that points at the duplicate
    for tbl,col in [('attendance','cleaner_id'),('property_cleaners','cleaner_id'),
                    ('staff_facility','cleaner_id'),('staff_facility_item','cleaner_id'),
                    ('cost_pool_source','cleaner_id'),('assets','custodian_id'),
                    ('asset_custody','cleaner_id')]:
        try: db.execute(f"UPDATE OR IGNORE {tbl} SET {col}=? WHERE {col}=?",(k['cleaner_id'],m['cleaner_id']))
        except sqlite3.OperationalError: pass
    # keep whichever salary figure actually exists
    db.execute("""UPDATE cleaners SET
                    monthly_salary=coalesce(monthly_salary,(SELECT monthly_salary FROM cleaners WHERE cleaner_id=?)),
                    employer_cost =coalesce(employer_cost ,(SELECT employer_cost  FROM cleaners WHERE cleaner_id=?))
                  WHERE cleaner_id=?""",(m['cleaner_id'],m['cleaner_id'],k['cleaner_id']))
    db.execute("DELETE FROM cleaners WHERE cleaner_id=?",(m['cleaner_id'],))
    db.execute("""INSERT INTO merge_log(entity,kept_id,kept_name,merged_id,merged_name,moved,actor)
                  VALUES('cleaner',?,?,?,?,'name variant','owner')""",
               (k['cleaner_id'],k['name'],m['cleaner_id'],m['name']))
    say(f"merged '{m['name']}' into '{k['name']}'")

# tidy the display names
for old,new in [('Ritesh pawar','Ritesh Pawar'),('SANA DI','Sana'),('debnath','Debnath'),
                ('hriday','Hriday'),('Kiran (not joined )','Kiran'),('Gangotri(not joined )','Gangotri')]:
    if one("SELECT 1 x FROM cleaners WHERE name=?",old) and not one("SELECT 1 x FROM cleaners WHERE name=?",new):
        db.execute("UPDATE cleaners SET name=? WHERE name=?",(new,old)); say(f"renamed '{old}' -> '{new}'")

# ---------- 2. Kiran and Gangotri started today -----------------------------
for nm in ['Kiran','Gangotri']:
    r=one("SELECT cleaner_id FROM cleaners WHERE name=?",nm)
    if r:
        db.execute("""UPDATE cleaners SET active=1, joined_month=?, exit_month=NULL,
                      source_of_truth='owner', notes=? WHERE cleaner_id=?""",
                   (THISMON, f'joined {TODAY} (owner) — no attendance yet', r['cleaner_id']))
        say(f"{nm}: marked as joined {TODAY}")

# ---------- 3. recompute every tenure from the attendance that remains ------
fixed=0
for c in db.execute("SELECT cleaner_id,name FROM cleaners").fetchall():
    a=one("""SELECT min(month) a, max(month) b, count(DISTINCT month) n
             FROM attendance WHERE cleaner_id=?""",c['cleaner_id'])
    if not a or not a['n']: continue
    active = 1 if a['b']==THISMON else 0
    db.execute("""UPDATE cleaners SET joined_month=?, exit_month=?, active=?
                  WHERE cleaner_id=?""",(a['a'], None if active else a['b'], active, c['cleaner_id']))
    fixed+=1
say(f"tenure recomputed from attendance for {fixed} people")

# ---------- 4. cash-paid staff carry no ESIC/PF -----------------------------
n=db.execute("""UPDATE cleaners SET on_roll=0,
                  notes=coalesce(nullif(notes,''),'')||' | paid in cash or other bank — no ESIC/PF (owner)'
                WHERE (employer_cost IS NULL OR employer_cost=0)
                  AND cleaner_id IN (SELECT DISTINCT cleaner_id FROM attendance WHERE cleaner_id IS NOT NULL)""").rowcount
say(f"{n} staff marked off-roll (cash / other bank, no ESIC-PF)")
db.execute("UPDATE cleaners SET on_roll=1 WHERE employer_cost>0")

# ---------- 5. December 2025 is a known gap, make it visible ----------------
db.execute("""CREATE TABLE IF NOT EXISTS data_gaps(
   gap_id INTEGER PRIMARY KEY, area TEXT, period TEXT, what TEXT, why TEXT,
   status TEXT DEFAULT 'open', expected_from TEXT, raised TEXT DEFAULT (date('now')),
   UNIQUE(area,period,what))""")
GAPS=[('attendance','2025-12','December 2025 attendance',
       "the 'dec 25' sheet is a byte-identical copy of 'jan 26' — same 13 people, same marks, same dates",'owner'),
      ('bank',None,'Two further bank accounts',
       'only the IDFC account has been loaded; salary and other payments also ran through two other banks','owner'),
      ('bank','2026-07..','IDFC statement after 30 Jun 2026',
       'the loaded statement stops at 2026-06-30; later months are not reconciled','owner'),
      ('salary',None,'Cash wages for off-roll staff',
       '23 people have attendance but no salary on record — paid in cash or from the other banks','owner')]
for a,p,w,y,f in GAPS:
    try: db.execute("INSERT INTO data_gaps(area,period,what,why,expected_from) VALUES(?,?,?,?,?)",(a,p,w,y,f))
    except sqlite3.IntegrityError: pass
say(f"{one('SELECT count(*) c FROM data_gaps')['c']} known gaps recorded and visible")

db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('owner','cleaners','update',?)",
  ("owner corrections: merged Ritesh/Om/Sana name variants; Kiran and Gangotri joined 2026-09-20; "
   "cash-paid staff marked off-roll; December 2025 attendance recorded as a known gap",))
db.commit()

print()
cur=db.execute("""SELECT name, joined_month, monthly_salary, employer_cost, on_roll,
                    (SELECT coalesce(sum(present),0) FROM attendance a WHERE a.cleaner_id=c.cleaner_id) p,
                    (SELECT count(DISTINCT month) FROM attendance a WHERE a.cleaner_id=c.cleaner_id) m
                  FROM cleaners c WHERE active=1 ORDER BY p DESC""").fetchall()
tot=sum(r['employer_cost'] or 0 for r in cur)
print(f"CURRENT STAFF ({len(cur)}) — on-roll CTC Rs {tot:,.0f}/month")
print("  "+"name".ljust(20)+"joined".ljust(9)+"mo".rjust(3)+"present".rjust(8)+"salary".rjust(10)+"CTC".rjust(10)+"  roll")
for r in cur:
    print("  "+r['name'][:19].ljust(20)+str(r['joined_month'] or '?').ljust(9)+str(r['m']).rjust(3)
      +str(int(r['p'])).rjust(8)
      +(f"{r['monthly_salary']:,.0f}" if r['monthly_salary'] else '—').rjust(10)
      +(f"{r['employer_cost']:,.0f}" if r['employer_cost'] else '—').rjust(10)
      +("  on-roll" if r['on_roll'] else "  CASH — salary needed"))
