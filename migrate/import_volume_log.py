#!/usr/bin/env python3
"""Import the daily laundry/cleaning volume log as BILLING EXPECTATION.
This never touches the ledger: it records what the operational log says should have
been billed, so the dashboard can show it beside what Tally actually billed."""
import sqlite3, sys, os, re, datetime, collections, unicodedata
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
from xlsxread import Book
DB=os.path.join(os.path.dirname(HERE),'db','swabha_finance.db')
LOG=os.path.expanduser("~/Downloads/Laundry + Cleaning Dec..xlsx")
CHAT=os.path.expanduser("~/Downloads/Swabha_Chat_Payments_Invoices.xlsx")

def sd(n):
    try:
        v=float(n)
        if v<30000 or v>60000: return None
        return (datetime.date(1899,12,30)+datetime.timedelta(days=int(v))).isoformat()
    except: return None
def f(v):
    try: return float(str(v).replace(',',''))
    except: return 0.0
def norm(s):
    s=unicodedata.normalize('NFKD',str(s or '')).lower()
    s=re.sub(r'\b(cleaning|laundry|pvt|private|limited|ltd|the)\b',' ',s)
    return re.sub(r'[^a-z0-9]+',' ',s).strip()
def toks(s): return set(t for t in norm(s).split() if len(t)>2)
ABBR={'t3':'the thinking three','tsc':'the serene cedars'}
def squash(s): return norm(s).replace(' ','')
def best(n,c,thr=0.45):
    # names are written inconsistently ("Pink city BNB" vs "Pinkcity BnB"), so compare
    # token overlap AND the space-stripped form, and allow a few known abbreviations.
    n = ABBR.get(squash(n), n)
    A=toks(n); sn=squash(n); bs=0; bn=None
    for x in c:
        B=toks(x); sx=squash(x)
        if not sn or not sx: continue
        if sn==sx: return (x,1.0)
        j=(len(A&B)/len(A|B)) if (A and B) else 0
        if sn and sx and (sn in sx or sx in sn):
            j=max(j, 0.9*min(len(sn),len(sx))/max(len(sn),len(sx)))
        if j>bs: bs,bn=j,x
    return (bn,round(bs,2)) if bs>=thr else (None,round(bs,2))

# --- rates live in the database; a per-host override beats the general card ---
rates={}
OVERRIDE={}   # (host_squash, item_norm) -> rate
try:
    cb=Book(CHAT); csh=dict(cb.sheets); rs=cb.rows(csh['Rate Cards'])
    hi=next(i for i,r in enumerate(rs) if sum(1 for c in r if c)>=3)
    hdr=[str(c).strip() if c else '' for c in rs[hi]]
    for r in rs[hi+1:]:
        if not any(r): continue
        r=r+[None]*(len(hdr)-len(r)); d={k:r[i] for i,k in enumerate(hdr) if k}
        item=norm(d.get('Item / service'))
        if item and f(d.get('Base price (INR)')): rates[item]=f(d.get('Base price (INR)'))
except Exception as e:
    print("  ! could not read Rate Cards:", e)
# column-name synonyms seen in the log
SYN={'singel bedsheet':'bedsheet single','single bedsheet':'bedsheet single','bed sheet':'bedsheet single',
 'double bedsheet':'bedsheet double','singel duvet ciover':'duvet cover','single duvet cover':'duvet cover',
 'double duvet cover':'duvet cover','duvet cover':'duvet cover','pillow cover':'pillow cover cushion cover',
 'pillow':'pillow cover cushion cover','cushion':'pillow cover cushion cover','bath mate':'bath mat',
 'bath mat':'bath mat','bath towel':'bath towel','hand towel':'hand towel face towel',
 'face towel':'hand towel face towel','small hand towel':'hand towel face towel','runner':'runner',
 'bath robe':'bath robe','blanket comforter':'blanket comforter','blanket':'blanket comforter',
 'comforter':'blanket comforter','carpet':'carpet','sofa cover':'sofa cover','door mat':'bath mat'}
def rate_for(col, host=None):
    k=norm(col); key=SYN.get(k,k)
    if host:
        hs=re.sub(r'[^a-z0-9]','',str(host).lower())
        for cand in (key,k):
            if (hs,cand) in OVERRIDE: return OVERRIDE[(hs,cand)]
        # the override sheets name items like "Bath Towel Wash"
        for (oh,oi),v in OVERRIDE.items():
            if oh==hs and (cand_in(oi,k) or cand_in(k,oi)): return v
    return rates.get(key) or rates.get(k)

def cand_in(a,b):
    a=a.replace(' wash','').strip(); b=b.replace(' wash','').strip()
    return bool(a) and bool(b) and (a in b or b in a)

db=sqlite3.connect(DB)
# database rate card wins over the workbook copy
for svc,item,base in db.execute("SELECT service,item,base_rate FROM rate_card WHERE service='laundry'"):
    rates[norm(item)]=base
for pn,item,base in db.execute(
        "SELECT party_name,item,base_rate FROM party_rate_override WHERE service='laundry'"):
    OVERRIDE[(re.sub(r'[^a-z0-9]','',str(pn).lower()), norm(item))]=base
CLEAN_RATE={k:v for k,v in db.execute(
    "SELECT size_key, base_rate FROM rate_card WHERE service='cleaning'")}
DEEP_RATE={k:v for k,v in db.execute(
    "SELECT size_key, base_rate FROM rate_card WHERE service='deep_cleaning'")}
def size_key(bedrooms, ptype=None):
    if ptype and str(ptype).lower().startswith('studio'): return 'studio'
    b=int(bedrooms or 0)
    if b<=0: return 'studio'
    return f'{min(b,6)}bhk'
# size of each property, and the dominant size per customer
psize={r[0]: size_key(r[1], r[2]) for r in db.execute(
    "SELECT name, bedrooms, type FROM properties")}
party_size={}
for nm, in db.execute("SELECT display_name FROM parties"):
    party_size[nm]=None
parties=[r[0] for r in db.execute("SELECT display_name FROM parties")]
pid={r[0]:r[1] for r in db.execute("SELECT display_name,party_id FROM parties")}
props={r[0]:r[1] for r in db.execute("SELECT name,property_id FROM properties")}

db.execute("DELETE FROM billing_expectation WHERE source='volume_log'")
b=Book(LOG); sh=dict(b.sheets)
made=0; unmatched=[]; unpriced=collections.Counter(); bysheet={}
for sheet,tgt in b.sheets:
    rs=b.rows(tgt)
    if not rs: continue
    hdr=[str(c).strip() if c else '' for c in rs[0]]
    low=[h.lower() for h in hdr]
    party,score=best(sheet,parties)
    prop,_=best(sheet,list(props.keys()),0.55)
    is_clean='cleaning count' in low
    agg=collections.defaultdict(lambda:[0.0,0.0])   # month -> [units, value]
    for r in rs[1:]:
        if not any(r): continue
        d=sd(r[0])
        if not d: continue
        r=r+[None]*(len(hdr)-len(r))
        for i,h in enumerate(hdr):
            if i==0 or not h: continue
            hl=h.lower()
            if hl in ('room no.','room no','date','rate','amount','total','bhk','remark','remarks','note'): continue
            if re.match(r'^[a-z]{1,3}\s*\d', hl) and 'bedsheet' not in hl: continue
            q=f(r[i])
            if q<=0: continue
            if is_clean and 'cleaning count' in hl or hl=='count':
                # price the visit by the property's size; the sheet's own BHK column wins
                bhk=None
                for j,h2 in enumerate(hdr):
                    if h2 and h2.strip().lower()=='bhk': bhk=f(r[j])
                ct=''
                for j,h2 in enumerate(hdr):
                    if h2 and 'cleaning type' in h2.strip().lower(): ct=str(r[j] or '').lower()
                if bhk and bhk>0: sk=f'{int(min(bhk,6))}bhk'
                elif prop and prop in psize: sk=psize[prop]
                else: sk='studio'
                rt=(DEEP_RATE.get(sk) or DEEP_RATE.get('3bhk')) if 'deep' in ct else CLEAN_RATE.get(sk)
                # a per-row Rate column, where present, is the truth
                for j,h2 in enumerate(hdr):
                    if h2 and h2.strip().lower()=='rate' and f(r[j])>0: rt=f(r[j])/1.18
                e=agg[(d[:7],'cleaning')]; e[0]+=q; e[1]+=q*(rt or 0)
            else:
                rt=rate_for(h, party or sheet)
                if rt is None: unpriced[h]+=q; continue
                e=agg[(d[:7],'laundry')]; e[0]+=q; e[1]+=q*rt
    for (month,service),(units,val) in sorted(agg.items()):
        db.execute("""INSERT INTO billing_expectation(party_id,party_name,property_id,month,service,
                      units,expected,source,detail) VALUES(?,?,?,?,?,?,?,?,?)""",
          (pid.get(party), party or sheet, props.get(prop), month, service, units, val,
           'volume_log', f"sheet '{sheet}'" + ('' if party else ' — CUSTOMER NOT MATCHED')))
        made+=1
    if not party: unmatched.append(sheet)
    bysheet[sheet]=(party,score)
db.commit()
print(f"imported {made} month/service rows from {len(sh)} sheets")
print(f"  matched to a customer : {len([1 for s,(p,_) in bysheet.items() if p])}")
print(f"  NOT matched           : {len(unmatched)} -> {', '.join(unmatched[:12])}")
if unpriced: print(f"  columns with no rate  : {dict(unpriced.most_common(8))}")
tot=db.execute("SELECT service, count(*) n, sum(units) u, sum(expected) v FROM billing_expectation GROUP BY 1").fetchall()
for s,n,u,v in tot: print(f"  {s:10} {n:4} rows  units {u:,.0f}  value Rs {v:,.0f}")
