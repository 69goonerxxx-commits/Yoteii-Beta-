import zipfile, struct, hashlib, base64, subprocess, sys, tempfile, os
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_der_public_key
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes
def verify(path):
    res={}; data=open(path,'rb').read(); z=zipfile.ZipFile(path)
    res['zip integrity']= z.testzip() is None
    # alignment of stored entries
    bad=0
    for i in z.infolist():
        if i.compress_type==0:
            with open(path,'rb') as f:
                f.seek(i.header_offset); h=f.read(30); n,e=struct.unpack('<HH',h[26:30]); 
                if (i.header_offset+30+n+e)%4: bad+=1
    res['stored entries 4-byte aligned']= bad==0
    # v1
    mf=z.read('META-INF/MANIFEST.MF'); sf=z.read('META-INF/YOTEII.SF'); rsa=z.read('META-INF/YOTEII.RSA')
    secs={}; 
    for blk in mf.split(b'\r\n\r\n')[1:]:
        if not blk.strip(): continue
        t=blk.replace(b'\r\n ',b'').decode(); d=dict(l.split(': ',1) for l in t.split('\r\n') if ': ' in l); secs[d['Name']]=(d['SHA-256-Digest'],blk+b'\r\n\r\n')
    ok=True
    for nm,(dg,_) in secs.items():
        if base64.b64encode(hashlib.sha256(z.read(nm)).digest()).decode()!=dg: ok=False
    names=[i.filename for i in z.infolist() if not i.filename.endswith('/') and i.filename not in ('META-INF/MANIFEST.MF','META-INF/YOTEII.SF','META-INF/YOTEII.RSA')]
    res['v1: every entry digest matches']= ok and set(names)==set(secs)
    sft=sf.replace(b'\r\n ',b'').decode(); m=[l for l in sft.split('\r\n') if l.startswith('SHA-256-Digest-Manifest:')][0].split(': ')[1]
    sfok = base64.b64encode(hashlib.sha256(mf).digest()).decode()==m
    for blk in sf.split(b'\r\n\r\n')[1:]:
        if not blk.strip(): continue
        t=blk.replace(b'\r\n ',b'').decode(); d=dict(l.split(': ',1) for l in t.split('\r\n') if ': ' in l)
        if base64.b64encode(hashlib.sha256(secs[d['Name']][1]).digest()).decode()!=d['SHA-256-Digest']: sfok=False
    res['v1: .SF digests match manifest']=sfok
    td=tempfile.mkdtemp(); open(td+'/a.sf','wb').write(sf); open(td+'/a.rsa','wb').write(rsa)
    r=subprocess.run(['openssl','smime','-verify','-inform','DER','-in',td+'/a.rsa','-content',td+'/a.sf','-noverify','-binary','-out','/dev/null'],capture_output=True,text=True)
    res['v1: PKCS7 signature valid']= 'Verification successful' in (r.stdout+r.stderr)
    # v2
    eo=data.rfind(b'PK\x05\x06'); cd_size,cd_off=struct.unpack('<II',data[eo+12:eo+20])
    assert data[cd_off-16:cd_off]==b'APK Sig Block 42', 'no v2 block'
    bsz=struct.unpack('<Q',data[cd_off-24:cd_off-16])[0]; bstart=cd_off-bsz-8
    pairs=data[bstart+8:cd_off-24]; pos=0; v2=None
    while pos<len(pairs):
        ln=struct.unpack('<Q',pairs[pos:pos+8])[0]; pid=struct.unpack('<I',pairs[pos+8:pos+12])[0]
        if pid==0x7109871a: v2=pairs[pos+12:pos+8+ln]
        pos+=8+ln
    def rd(b,p): n=struct.unpack('<I',b[p:p+4])[0]; return b[p+4:p+4+n],p+4+n
    seq,_=rd(v2,0); signer,_=rd(seq,0); signed,p=rd(signer,0); sigs,p=rd(signer,p); pub,p=rd(signer,p)
    ds,q=rd(signed,0); cs,q=rd(signed,q); dent,_=rd(ds,0); algo=struct.unpack('<I',dent[:4])[0]; dig,_=rd(dent,4)
    cder,_=rd(cs,0); sent,_=rd(sigs,0); salgo=struct.unpack('<I',sent[:4])[0]; sig,_=rd(sent,4)
    cert=x509.load_der_x509_certificate(cder)
    try: cert.public_key().verify(sig,signed,padding.PKCS1v15(),hashes.SHA256()); sigok=True
    except Exception: sigok=False
    parts=[data[:bstart],data[cd_off:cd_off+cd_size],data[eo:eo+16]+struct.pack('<I',bstart)+data[eo+20:]]
    dl=[]
    for pt in parts:
        for i in range(0,len(pt),1<<20):
            c=pt[i:i+(1<<20)]; dl.append(hashlib.sha256(b'\xa5'+struct.pack('<I',len(c))+c).digest())
    top=hashlib.sha256(b'\x5a'+struct.pack('<I',len(dl))+b''.join(dl)).digest()
    res['v2: signature valid']= sigok and algo==0x0103 and salgo==0x0103
    res['v2: digest of the file matches']= top==dig
    res['v2: key in block matches certificate']= pub==cert.public_key().public_bytes(Encoding.DER,PublicFormat.SubjectPublicKeyInfo)
    res['_sha256']=hashlib.sha256(cder).hexdigest().upper(); res['_sha1']=hashlib.sha1(cder).hexdigest().upper()
    return res
if __name__=='__main__':
    for p in sys.argv[1:]:
        print('==',p)
        for k,v in verify(p).items(): print(('  PASS ' if v is True else '  FAIL ' if v is False else '  ')+k+('' if isinstance(v,bool) else ': '+v))
