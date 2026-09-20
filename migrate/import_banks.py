#!/usr/bin/env python3
"""Universal bank statement importer — IDFC and Central Bank layouts.
Rows are fingerprinted, so re-importing an overlapping statement adds only what is new."""
import sqlite3, sys, os, re, glob, datetime, hashlib
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
D=os.path.expanduser("~/Downloads/")
db=sqlite3.connect(DB); db.row_factory=sqlite3.Row

def money(v):
    if v is None: return 0.0
    s=str(v).replace(',','').replace('CR','').replace('DR','').strip()
    if not s or s=='-': return 0.0
    try: return abs(float(s))
    except: return 0.0
def pdate(s):
    s=str(s or '').strip()
    for f in ("%d-%b-%Y","%d/%m/%Y","%Y-%m-%d","%d-%m-%Y"):
        try: return datetime.datetime.strptime(s,f).date().isoformat()
        except: pass
    return None
def clean(h): return re.sub(r'\s+',' ',str(h or '')).strip()

def bank_id_for(nickname, bank, acct, ifsc, holder, kind):
    r=db.execute("SELECT bank_id FROM bank_accounts WHERE account_no=?", (acct,)).fetchone()
    if r: return r['bank_id']
    c=db.execute("""INSERT INTO bank_accounts(nickname,bank,account_no,ifsc,holder,in_books,notes)
                    VALUES(?,?,?,?,?,1,?)""",(nickname,bank,acct,ifsc,holder,kind))
    # give it a matching account record so ledger entries can point at it
    db.execute("INSERT OR IGNORE INTO accounts(name,kind,in_books,notes) VALUES(?,?,1,?)",
               (nickname,'company_bank',kind))
    a=db.execute("SELECT account_id FROM accounts WHERE name=?", (nickname,)).fetchone()
    if a: db.execute("UPDATE bank_accounts SET account_id=? WHERE bank_id=?",(a['account_id'],c.lastrowid))
    return c.lastrowid

total_new=0; summary=[]
def ingest(bank_id, rows, src_file, src_sheet, acct):
    global total_new
    new=dup=0
    for rownum, d in rows:
        dt=d['date']
        fp=hashlib.sha1(f"{acct}|{dt}|{d['debit']}|{d['credit']}|{d['particulars']}|{d['balance']}".encode()).hexdigest()
        try:
            db.execute("""INSERT INTO bank_transactions(bank_id,txn_date,value_date,month,particulars,
                cheque_no,debit,credit,balance,counterparty,nature,src_file,src_sheet,src_row,fingerprint)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (bank_id,dt,d.get('value_date'),dt[:7],d['particulars'],d.get('cheque'),
               d['debit'],d['credit'],d['balance'],d.get('name'),d.get('nature'),
               src_file,src_sheet,rownum,fp))
            new+=1
        except sqlite3.IntegrityError: dup+=1
    total_new+=new
    summary.append((src_file[:46], len(rows), new, dup))
    return new,dup

# ---------------- IDFC ----------------
for path in sorted(glob.glob(D+"IDFCFIRSTBankstatement_*.xlsx"))+sorted(glob.glob(D+"IDFC BANK STATEMENT.xlsx")):
    b=Book(path)
    for sheet,tgt in b.sheets:
        if 'account statement' not in sheet.lower(): continue
        rs=b.rows(tgt)
        hi=next((i for i,r in enumerate(rs[:30])
                 if r and any(clean(c)=='Transaction Date' for c in r if c)),None)
        if hi is None: continue
        meta={}
        for r in rs[:hi]:
            a=[str(c).strip() for c in r if c]
            if len(a)>=2: meta[a[0].upper()]=a[1]
        acct=meta.get('ACCOUNT NUMBER','')
        if not acct: continue
        bid=bank_id_for('IDFC Current','IDFC FIRST BANK',acct,meta.get('IFSC'),
                        meta.get('CUSTOMER NAME'),'current account')
        hdr=[clean(c) for c in rs[hi]]
        idx={h:i for i,h in enumerate(hdr) if h}
        out=[]
        for n,r in enumerate(rs[hi+1:],start=hi+2):
            if not any(r): continue
            r=r+[None]*(len(hdr)-len(r))
            dt=pdate(r[idx.get('Transaction Date',0)])
            if not dt: continue
            out.append((n,{'date':dt,'value_date':pdate(r[idx['Value Date']]) if 'Value Date' in idx else None,
              'particulars':str(r[idx.get('Particulars',2)] or '').strip(),
              'cheque':r[idx['Cheque No.']] if 'Cheque No.' in idx else None,
              'debit':money(r[idx['Debit']]) if 'Debit' in idx else 0,
              'credit':money(r[idx['Credit']]) if 'Credit' in idx else 0,
              'balance':money(r[idx['Balance']]) if 'Balance' in idx else None,
              'name':r[idx['NAME']] if 'NAME' in idx else None,
              'nature':r[idx['NATURE OF TRANSACTION']] if 'NATURE OF TRANSACTION' in idx else None}))
        ingest(bid,out,os.path.basename(path),sheet,acct)

# ---------------- Central Bank of India ----------------
KIND={'TL':'term loan','CC/OD':'cash credit / overdraft','CD':'current account'}
for path in sorted(glob.glob(D+"ACCOUNT_STATEMENT_*.xlsx")):
    b=Book(path)
    for sheet,tgt in b.sheets:
        rs=b.rows(tgt)
        hi=next((i for i,r in enumerate(rs[:30]) if r and any(clean(c)=='Post Date' for c in r if c)),None)
        if hi is None: continue
        meta={}
        for r in rs[:hi]:
            a=[str(c).strip() for c in r if c]
            if a and ':' in a[0]:
                k,_,v=a[0].partition(':'); meta[k.strip().upper()]=v.strip()
            elif a: meta.setdefault('_LINES',[]).append(a[0])
        acct=meta.get('ACCOUNT NUMBER','').strip()
        if not acct: continue
        ptype=meta.get('PRODUCT TYPE','')
        kind=next((v for k,v in KIND.items() if ptype.upper().startswith(k)), ptype[:30])
        short=acct[-4:]
        nick=f"CBI {kind.split()[0].title()} …{short}"
        bid=bank_id_for(nick,'Central Bank of India',acct,meta.get('IFSC CODE'),
                        'SWABHA SOLUTIONS PRIVATE LIMITED',kind)
        hdr=[clean(c) for c in rs[hi]]
        idx={h:i for i,h in enumerate(hdr) if h}
        out=[]
        for n,r in enumerate(rs[hi+1:],start=hi+2):
            if not any(r): continue
            r=r+[None]*(len(hdr)-len(r))
            dt=pdate(r[idx.get('Post Date',0)])
            if not dt: continue
            out.append((n,{'date':dt,
              'value_date':pdate(r[idx['Value Date']]) if 'Value Date' in idx else None,
              'particulars':str(r[idx.get('Account Description',4)] or '').strip(),
              'cheque':(str(r[idx['Cheque Number']]).strip() or None) if 'Cheque Number' in idx else None,
              'debit':money(r[idx['Debit']]) if 'Debit' in idx else 0,
              'credit':money(r[idx['Credit']]) if 'Credit' in idx else 0,
              'balance':money(r[idx['Balance']]) if 'Balance' in idx else None,
              'name':None,'nature':None}))
        ingest(bid,out,os.path.basename(path),sheet,acct)

db.commit()
print("  file                                            rows   new   dup")
for f,n,new,dup in summary:
    print(f"  {f:46} {n:5} {new:5} {dup:5}")
print(f"\n  {total_new} new bank rows added")
print()
print("  ACCOUNTS NOW TRACKED:")
for r in db.execute("""SELECT b.nickname,b.bank,b.account_no,b.notes,count(t.bt_id) n,
                         min(t.txn_date) a,max(t.txn_date) z,
                         coalesce(sum(t.debit),0) d, coalesce(sum(t.credit),0) c
                       FROM bank_accounts b LEFT JOIN bank_transactions t USING(bank_id)
                       GROUP BY b.bank_id ORDER BY n DESC"""):
    print(f"   {r['nickname']:24} {str(r['notes'])[:22]:24} {r['n']:4} rows  {r['a']} -> {r['z']}")
    print(f"      out Rs {r['d']:>12,.0f}   in Rs {r['c']:>12,.0f}")
db.execute("INSERT INTO audit_log(actor,table_name,action,note) VALUES('system','bank_transactions','import',?)",
  (f"bank import: {total_new} new rows across {len(summary)} statement files",))
db.commit()
