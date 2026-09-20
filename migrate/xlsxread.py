import zipfile, re, sys
from xml.etree import ElementTree as ET
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

def colnum(ref):
    m=re.match(r'([A-Z]+)',ref)
    n=0
    for ch in m.group(1): n=n*26+ord(ch)-64
    return n-1

class Book:
    def __init__(self,path):
        self.z=zipfile.ZipFile(path)
        self.shared=self._shared()
        self.sheets=self._sheets()
    def _shared(self):
        out=[]
        if 'xl/sharedStrings.xml' not in self.z.namelist(): return out
        r=ET.fromstring(self.z.read('xl/sharedStrings.xml'))
        for si in r.findall(NS+'si'):
            out.append(''.join(t.text or '' for t in si.iter(NS+'t')))
        return out
    def _sheets(self):
        wb=ET.fromstring(self.z.read('xl/workbook.xml'))
        rels={}
        rr=ET.fromstring(self.z.read('xl/_rels/workbook.xml.rels'))
        for rel in rr: rels[rel.get('Id')]=rel.get('Target')
        out=[]
        for sh in wb.find(NS+'sheets'):
            tgt=rels[sh.get(RNS+'id')].lstrip('/')
            if not tgt.startswith('xl/'): tgt='xl/'+tgt
            out.append((sh.get('name'),tgt))
        return out
    def rows(self,target,limit=None):
        data=self.z.read(target)
        root=ET.fromstring(data)
        sd=root.find(NS+'sheetData')
        res=[]
        for i,row in enumerate(sd):
            if limit and i>=limit: break
            cells={}
            for c in row:
                t=c.get('t'); v=c.find(NS+'v'); isel=c.find(NS+'is')
                if isel is not None:
                    val=''.join(x.text or '' for x in isel.iter(NS+'t'))
                elif v is None: val=None
                elif t=='s': val=self.shared[int(v.text)]
                else: val=v.text
                cells[colnum(c.get('r'))]=val
            if cells:
                w=max(cells)+1
                res.append([cells.get(j) for j in range(w)])
            else: res.append([])
        return res

if __name__=='__main__':
    b=Book(sys.argv[1])
    print("SHEETS:")
    for n,t in b.sheets:
        rs=b.rows(t)
        print(f"  - {n!r}: {len(rs)} rows")
