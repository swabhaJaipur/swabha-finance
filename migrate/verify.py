import sqlite3, os
db = sqlite3.connect(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"db","swabha_finance.db"))
q = lambda s,*a: db.execute(s,a).fetchall()
def L(x): return f"{x/100000:,.2f}L"
print("="*72); print("MONEY IN / OUT  (gross, from Tally source of record)"); print("="*72)
for d,k,c,amt in q("""SELECT t.direction, c.kind, count(*), sum(t.gross_amount)
                      FROM transactions t JOIN categories c USING(category_id)
                      WHERE t.status='Posted' GROUP BY 1,2 ORDER BY 4 DESC"""):
    print(f"  {d:4} {k:15} {c:4} txns   Rs {amt:>13,.0f}  ({L(amt)})")
inn  = q("SELECT coalesce(sum(gross_amount),0) FROM transactions WHERE direction='in'  AND status='Posted'")[0][0]
out  = q("SELECT coalesce(sum(gross_amount),0) FROM transactions WHERE direction='out' AND status='Posted'")[0][0]
capex= q("""SELECT coalesce(sum(gross_amount),0) FROM transactions t JOIN categories c USING(category_id)
            WHERE c.kind='capex' AND status='Posted'""")[0][0]
gst  = q("SELECT coalesce(sum(cgst+sgst+igst),0) FROM transactions WHERE status='Posted'")[0][0]
print(f"\n  IN  Rs {inn:>13,.0f}   OUT Rs {out:>13,.0f}   NET Rs {inn-out:>13,.0f}   ({L(inn-out)})")
print(f"  of which capex Rs {capex:,.0f}  |  GST in the above Rs {gst:,.0f}")
print(f"  operating net excl. capex:  Rs {inn-(out-capex):,.0f}  ({L(inn-(out-capex))})")

print("\n"+"="*72); print("ATTRIBUTION GAP — can we trace money to a property?"); print("="*72)
tot = q("SELECT sum(gross_amount) FROM transactions WHERE direction='in' AND status='Posted'")[0][0]
mapped = q("""SELECT coalesce(sum(t.gross_amount),0) FROM transactions t
              WHERE t.direction='in' AND t.status='Posted'
                AND t.party_id IN (SELECT party_id FROM party_properties)""")[0][0]
print(f"  revenue traceable to a property : Rs {mapped:,.0f}  ({100*mapped/tot:.1f}%)")
print(f"  revenue that is NOT             : Rs {tot-mapped:,.0f}  ({100*(tot-mapped)/tot:.1f}%)  <-- the blocker")
print(f"  parties total {q('SELECT count(*) FROM parties')[0][0]}, mapped to a property {q('SELECT count(DISTINCT party_id) FROM party_properties')[0][0]}")

print("\n"+"="*72); print("TOP 12 PARTIES BY MONEY IN  (these are what must be mapped first)"); print("="*72)
for n,c,amt,h in q("""SELECT p.display_name, count(*), sum(t.gross_amount),
                        (SELECT count(*) FROM party_properties pp WHERE pp.party_id=p.party_id)
                      FROM transactions t JOIN parties p USING(party_id)
                      WHERE t.direction='in' AND t.status='Posted'
                      GROUP BY 1 ORDER BY 3 DESC LIMIT 12"""):
    print(f"  {'OK ' if h else '>> '}{n[:38]:40} {c:4} txns  Rs {amt:>11,.0f}")

print("\n"+"="*72); print("OUTSTANDING — money owed to you (2026-09)"); print("="*72)
tot_o=0
for n,t_,r_,st in q("""SELECT coalesce(p.display_name,'(unmatched)'), i.total, i.received, i.status
                       FROM invoices i LEFT JOIN parties p USING(party_id)
                       ORDER BY i.total DESC LIMIT 10"""):
    print(f"  {n[:34]:36} billed Rs {t_:>9,.0f}   received Rs {r_:>8,.0f}   {st}")
tot_o = q("SELECT sum(total-received) FROM invoices")[0][0]
print(f"\n  TOTAL UNCOLLECTED: Rs {tot_o:,.0f}  ({L(tot_o)})   across {q('SELECT count(*) FROM invoices')[0][0]} parties")

print("\n"+"="*72); print("FLAGS RAISED"); print("="*72)
for ft,sev,c in q("SELECT flag_type,severity,count(*) FROM data_flags GROUP BY 1,2 ORDER BY 3 DESC"):
    print(f"  [{sev:6}] {ft:24} {c}")
print("\n"+"="*72); print("MISSING MASTER DATA (blocks profitability)"); print("="*72)
print(f"  properties with no billing rate : {q('SELECT count(*) FROM properties WHERE package_rate IS NULL AND per_cleaning_price IS NULL')[0][0]} of 80")
print(f"  cleaners with no pay rate       : {q('SELECT count(*) FROM cleaners WHERE pay_rate IS NULL AND monthly_salary IS NULL')[0][0]} of 11")
print(f"  hosts with no usable phone      : {q("SELECT count(*) FROM hosts WHERE phone IS NULL")[0][0]} of 34")
print(f"  opening bank balance            : {'SET' if q('SELECT count(*) FROM opening_balances')[0][0] else 'NOT SET'}")
print(f"  data ends                       : {q('SELECT max(txn_date) FROM transactions')[0][0]}   (today 2026-09-20)")
