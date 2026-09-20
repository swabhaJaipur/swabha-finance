#!/usr/bin/env python3
"""Apply the owner's decisions from the returned duplicates workbook.
Nothing is hard-deleted: a removed duplicate is marked Cancelled, which takes it out of
every figure and every chart but leaves the record recoverable."""
import sqlite3, sys, os, re
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
SRC=os.path.expanduser("~/Desktop/Swabha_Duplicates_To_Clear.xlsx")
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row

b=Book(SRC); sh=dict(b.sheets)
rs=b.rows(sh[[n for n,_ in b.sheets][0]])
hdr=[str(c).strip() if c else '' for c in rs[0]]
iDec=0
iRef=next(i for i,h in enumerate(hdr) if h.startswith('A: Ref'))
removed=parked=skipped=0
rem_val=park_val=0.0
db.execute("BEGIN")
for r in rs[1:]:
    if not any(r): continue
    r=r+[None]*(len(hdr)-len(r))
    dec=str(r[iDec] or '').strip().lower()
    ref=str(r[iRef] or '')
    m=re.search(r'txn#(\d+)', ref)
    if not m: continue
    tid=int(m.group(1))
    t=db.execute("SELECT txn_id,gross_amount,status,source FROM transactions WHERE txn_id=?",(tid,)).fetchone()
    if not t: skipped+=1; continue
    if dec.startswith('remove'):
        db.execute("""UPDATE transactions SET status='Cancelled',
              suspense_note='removed as a duplicate of an entry already in the ledger (owner 2026-09-20)'
            WHERE txn_id=?""",(tid,))
        db.execute("UPDATE data_flags SET resolved=1 WHERE txn_id=?",(tid,))
        removed+=1; rem_val+=t['gross_amount']
    elif dec.startswith('keep') or 'keeo' in dec:
        db.execute("""UPDATE transactions SET needs_review=1,
              suspense_note='owner kept this entry; the duplicate question is parked in Suspense (2026-09-20)'
            WHERE txn_id=?""",(tid,))
        db.execute("UPDATE data_flags SET resolved=1 WHERE txn_id=?",(tid,))
        parked+=1; park_val+=t['gross_amount']
    else:
        skipped+=1
db.execute("""INSERT INTO audit_log(actor,table_name,action,note) VALUES('owner','transactions','update',?)""",
  (f"duplicate decisions applied: {removed} marked Cancelled (removed from all figures), "
   f"{parked} kept and parked in Suspense, {skipped} with no decision",))
db.commit()
print(f"removed (marked Cancelled) : {removed}   Rs {rem_val:,.0f}")
print(f"kept, parked in Suspense   : {parked}   Rs {park_val:,.0f}")
print(f"no decision / not found    : {skipped}")
open_f=db.execute("SELECT count(*) n FROM data_flags WHERE resolved=0 AND flag_type='possible_duplicate'").fetchone()['n']
print(f"duplicate flags still open : {open_f}")
