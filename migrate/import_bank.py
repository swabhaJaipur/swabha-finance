#!/usr/bin/env python3
"""Import the IDFC statement into bank_transactions and match it against Tally.
The file holds two copies of the SAME account; only the longer one is used."""
import sqlite3, sys, os, re, datetime, hashlib
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
SRC=os.path.expanduser("~/Downloads/IDFC BANK STATEMENT.xlsx")

def f(v):
    try: return float(str(v).replace(',',''))
    except: return 0.0
def pd(s):
    for fmt in ("%d-%b-%Y","%d/%m/%Y","%Y-%m-%d","%d-%m-%Y"):
        try: return datetime.datetime.strptime(str(s).strip(),fmt).date().isoformat()
        except: pass
    return None

db=sqlite3.connect(DB); db.row_factory=sqlite3.Row
b=Book(SRC); sh=dict(b.sheets)

def read(sheet):
    rs=b.rows(sh[sheet])
    hi=next((i for i,r in enumerate(rs[:40]) if r and any(str(c).strip()=='Transaction Date' for c in r if c)),None)
    if hi is None: return None,None,[]
    hdr=[str(c).strip() if c else '' for c in rs[hi]]
    meta={}
    for r in rs[:hi]:
        a=[str(c).strip() for c in r if c]
        if len(a)>=2: meta[a[0].upper()]=a[1]
    out=[]
    for n,r in enumerate(rs[hi+1:], start=hi+2):
        if not any(r): continue
        r=r+[None]*(len(hdr)-len(r)); d={k:r[i] for i,k in enumerate(hdr) if k}
        if pd(d.get('Transaction Date')): out.append((n,d))
    return meta,hdr,out

# pick the longer of the duplicate statements — that is the deduplication
best=None
for name in [n for n,_ in b.sheets if 'account statement' in n.lower()]:
    meta,hdr,rows=read(name)
    if not rows: continue
    print(f"  {name:26} {len(rows):4} rows  a/c {meta.get('ACCOUNT NUMBER','?')}")
    if best is None or len(rows)>len(best[2]): best=(name,meta,rows)
name,meta,rows=best
print(f"\nusing '{name}' ({len(rows)} rows) — the other copy is a subset of the same account\n")

acct=meta.get('ACCOUNT NUMBER','')
cur=db.execute("SELECT bank_id FROM bank_accounts WHERE account_no=?", (acct,)).fetchone()
if cur: bank_id=cur['bank_id']
else:
    c=db.execute("""INSERT INTO bank_accounts(nickname,bank,account_no,ifsc,holder,in_books)
                    VALUES(?,?,?,?,?,1)""",
       ('IDFC Current','IDFC FIRST BANK',acct,meta.get('IFSC'),meta.get('CUSTOMER NAME')))
    bank_id=c.lastrowid
# link it to the company bank account record
a=db.execute("SELECT account_id FROM accounts WHERE kind='company_bank'").fetchone()
if a: db.execute("UPDATE bank_accounts SET account_id=? WHERE bank_id=?", (a['account_id'],bank_id))

ins=dup=0
for rownum,d in rows:
    dt=pd(d.get('Transaction Date')); dr=f(d.get('Debit')); cr=f(d.get('Credit'))
    part=str(d.get('Particulars') or '').strip()
    fp=hashlib.sha1(f"{acct}|{dt}|{dr}|{cr}|{part}|{f(d.get('Balance'))}".encode()).hexdigest()
    try:
        db.execute("""INSERT INTO bank_transactions(bank_id,txn_date,value_date,month,particulars,
            cheque_no,debit,credit,balance,counterparty,nature,src_file,src_sheet,src_row,fingerprint)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (bank_id,dt,pd(d.get('Value Date')),dt[:7],part,d.get('Cheque No.'),dr,cr,
           f(d.get('Balance')),d.get('NAME'),d.get('NATURE OF TRANSACTION'),
           os.path.basename(SRC),name,rownum,fp))
        ins+=1
    except sqlite3.IntegrityError:
        dup+=1
db.commit()
print(f"bank rows imported: {ins}  (skipped {dup} identical duplicates)")

# --- match against Tally: same amount, within 4 days ---
m_exact=m_near=0
for bt in db.execute("SELECT * FROM bank_transactions WHERE status='unmatched'").fetchall():
    amt = bt['debit'] or bt['credit']
    if not amt: continue
    direction = 'out' if bt['debit'] else 'in'
    hit=db.execute("""SELECT txn_id, txn_date, gross_amount FROM transactions
        WHERE direction=? AND status='Posted' AND abs(gross_amount-?)<0.51
          AND abs(julianday(txn_date)-julianday(?))<=4
          AND txn_id NOT IN (SELECT matched_txn_id FROM bank_transactions WHERE matched_txn_id IS NOT NULL)
        ORDER BY abs(julianday(txn_date)-julianday(?)) LIMIT 1""",
        (direction, amt, bt['txn_date'], bt['txn_date'])).fetchone()
    if hit:
        kind='exact' if hit['txn_date']==bt['txn_date'] else 'near'
        db.execute("UPDATE bank_transactions SET matched_txn_id=?, match_kind=?, status='matched' WHERE bt_id=?",
                   (hit['txn_id'], kind, bt['bt_id']))
        if kind=='exact': m_exact+=1
        else: m_near+=1
db.commit()
tot=db.execute("""SELECT count(*) n, sum(debit) d, sum(credit) c FROM bank_transactions""").fetchone()
un=db.execute("""SELECT count(*) n, sum(debit) d, sum(credit) c FROM bank_transactions WHERE status='unmatched'""").fetchone()
print(f"matched to Tally: {m_exact} exact + {m_near} within 4 days = {m_exact+m_near}")
print(f"still unmatched : {un['n']} rows | Rs {un['d'] or 0:,.0f} out, Rs {un['c'] or 0:,.0f} in")
print(f"                  ^ this is the money that never reached Tally")
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('system','bank_transactions','import',?)",
  (f"IDFC statement {name}: {ins} rows, {m_exact+m_near} matched to Tally, {un['n']} unmatched",))
db.commit()
