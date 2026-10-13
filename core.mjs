// Inti aturan CryptoEliz. Dipakai bersama oleh halaman jurnal dan script GitHub Actions.
const HOSTS=['https://data-api.binance.vision','https://api.binance.com','https://api1.binance.com','https://api2.binance.com'];
let hi=0;
export async function bj(p){let e;for(let t=0;t<HOSTS.length;t++){const h=HOSTS[(hi+t)%HOSTS.length];
 try{const r=await fetch(h+'/api/v3/'+p,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(h+' HTTP '+r.status);hi=(hi+t)%HOSTS.length;return await r.json()}catch(x){e=x}}throw e}
export const kl=async s=>(await bj(`klines?symbol=${s}&interval=1d&limit=1000`)).map(a=>({t:a[0],o:+a[1],h:+a[2],l:+a[3],c:+a[4],v:+a[5]}));
export const NOT=/^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|AEUR|USD1|XUSD|PAXG|USDE|PYUSD|U|USDS|USDD|RLUSD|BFUSD|USDG)$/;
// Tanggal keputusan FOMC 2026 (hari ke-2). WAJIB diverifikasi di federalreserve.gov
const FOMC=['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09'];
const HOL=['12-24','12-25','12-26','12-31','01-01'];
const ema=(a,n)=>{const k=2/(n+1);let e=a[0];return a.map(v=>e=v*k+e*(1-k))};
const rsi=(c,n=14)=>{let g=0,l=0;return c.map((v,i)=>{if(!i)return null;const d=v-c[i-1],u=Math.max(d,0),w=Math.max(-d,0);if(i<=n){g+=u/n;l+=w/n}else{g=(g*(n-1)+u)/n;l=(l*(n-1)+w)/n}return i<n?null:100-100/(1+g/(l||1e-9))})};
const obv=k=>{let o=0;return k.map((x,i)=>{if(i)o+=x.c>k[i-1].c?x.v:x.c<k[i-1].c?-x.v:0;return o})};
function div(p,d){const n=p.length,ix=(a,b,f)=>{let j=a;for(let i=a;i<b;i++)if(f(p[i],p[j]))j=i;return j};
 const l1=ix(n-15,n,(v,m)=>v<m),l0=ix(n-30,n-15,(v,m)=>v<m),h1=ix(n-15,n,(v,m)=>v>m),h0=ix(n-30,n-15,(v,m)=>v>m);
 if(p[l1]<p[l0]&&d[l1]>d[l0])return 1;if(p[h1]>p[h0]&&d[h1]<d[h0])return -1;return 0}
const sgn=(p,a,b)=>p>b&&a>b?1:p<b&&a<b?-1:0;

export function feat(k,qv){
 const x=k.slice(0,-1),c=x.map(q=>q.c),n=x.length,px=k.at(-1).c;
 if(n<120)throw new Error('data kurang dari 120 hari');
 const E20=ema(c,20)[n-1],E50=ema(c,50)[n-1],td=sgn(px,E20,E50);
 // tren weekly: agregasi dari candle harian (minggu mulai Senin UTC), EMA20/50
 const wm=new Map();for(const q of x){const i=Math.floor((q.t-4*864e5)/(7*864e5)),o=wm.get(i)||{l:1e18,h:0};wm.set(i,{c:q.c,l:Math.min(o.l,q.l),h:Math.max(o.h,q.h)})}
 const wv=[...wm.values()].slice(0,-1),wc=wv.map(w=>w.c),m=wc.length,wlow=Math.min(...wv.slice(-26).map(w=>w.l)),whigh=Math.max(...wv.slice(-26).map(w=>w.h));let tw=0,flip=false;
 if(m>=55){const a=ema(wc,20),b=ema(wc,50);tw=sgn(px,a[m-1],b[m-1]);flip=sgn(wc[m-4],a[m-4],b[m-4])!==sgn(wc[m-1],a[m-1],b[m-1])}
 const tr=m>=55?tw:td; // tren makro: weekly bila data cukup
 const R=rsi(c),dO=div(c,obv(x)),dR=div(c,R);
 const pr=x.slice(n-65,n-5),H=Math.max(...pr.map(q=>q.h)),L=Math.min(...pr.map(q=>q.l)),rec=x.slice(n-5);
 const pos=(px-L)/(H-L),mid=pos>.3&&pos<.7,flat=(H-L)/L<.06;
 // zona demand/supply = kotak setebal 0.6 ATR dari tepi range (maks 1/4 range)
 const atr=x.slice(n-14).reduce((s,q,i,a)=>s+Math.max(q.h-q.l,i?Math.abs(q.h-a[i-1].c):0,i?Math.abs(q.l-a[i-1].c):0),0)/14,bd=Math.min(.6*atr,(H-L)/4),zs={a:L,b:L+bd},zr={a:H-bd,b:H};
 const devUp=px>L&&rec.some(q=>q.l<L&&q.c>L),devDn=px<H&&rec.some(q=>q.h>H&&q.c<H);
 const boUp=x.slice(n-10).some(q=>q.c>H)&&px>H&&px<H*1.03,boDn=x.slice(n-10).some(q=>q.c<L)&&px<L&&px>L*.97;
 const w=x.slice(n-60),hh=Math.max(...w.map(q=>q.h)),lo=Math.min(...w.map(q=>q.l));
 const f75=tr>=0?hh-.75*(hh-lo):lo+.75*(hh-lo),nf=Math.abs(px-f75)/px<.03;
 // Monday High/Low: candle harian Senin UTC terakhir (<=7 hari), jadi level kunci sepanjang minggu
 let mI=-1;for(let i=n-1;i>=n-7;i--)if(new Date(x[i].t).getUTCDay()===1){mI=i;break}
 const cur=k.at(-1),monL=mI>=0?x[mI].l:null,monH=mI>=0?x[mI].h:null;
 const mDevUp=mI>=0&&px>monL&&(x.slice(mI+1).some(q=>q.l<monL&&q.c>monL)||cur.l<monL),mDevDn=mI>=0&&px<monH&&(x.slice(mI+1).some(q=>q.h>monH&&q.c<monH)||cur.h>monH);
 // pivot +-3 hari (90 hari terakhir) untuk Three Tap dan Wolf
 const hs=x.map(q=>q.h),ls=x.map(q=>q.l);
 const pv=(a,i,hi)=>{for(let j=i-3;j<=i+3;j++)if(j!==i&&(hi?a[j]>a[i]:a[j]<a[i]))return false;return true};
 const PH=[],PL=[];for(let i=n-90;i<n-3;i++){if(pv(hs,i,1))PH.push(i);if(pv(ls,i,0))PL.push(i)}
 const tl=(P,a_,desc)=>{if(P.length<2)return null;const a=P.at(-2),b=P.at(-1);if(b-a<5||(desc?a_[b]>=a_[a]:a_[b]<=a_[a]))return null;return{a,av:a_[a],sl:(a_[b]-a_[a])/(b-a)}};
 const TH=tl(PH,hs,1),TL=tl(PL,ls,0),ln=(T,i)=>T.av+T.sl*(i-T.a);
 const brk=(T,a_,up)=>!!T&&[0,1,2,3,4].some(j=>up?a_[n-1-j]>ln(T,n-1-j):a_[n-1-j]<ln(T,n-1-j));
 const wDn=brk(TH,hs,1)&&px<ln(TH,n)&&c[n-1]<ln(TH,n-1),wUp=brk(TL,ls,0)&&px>ln(TL,n)&&c[n-1]>ln(TL,n-1);
 const tL=PL.filter(i=>i>=n-65&&i<n-5&&ls[i]<=L*1.02).length,tH=PH.filter(i=>i>=n-65&&i<n-5&&hs[i]>=H*.98).length;
 // Double Deviation (diagram Eliz): 2 sweep di luar level, sweep ke-2 lebih dangkal, keduanya reclaim, sweep ke-2 dalam 10 hari
 const Zs=Math.min(...c.slice(n-90)),Zh=Math.max(...c.slice(n-90));
 const swp=(a_,z,up)=>{const S=[];for(let i=n-60;i<n;i++)if(up?a_[i]<z*.998&&c[i]>z:a_[i]>z*1.002&&c[i]<z)if(!S.length||i-S.at(-1)>=3)S.push(i);return S};
 const sU=swp(ls,Zs,1),sD=swp(hs,Zh,0);
 const ddUp=sU.length>=2&&sU.at(-1)>=n-10&&ls[sU.at(-1)]>ls[sU.at(-2)]&&px>Zs,ddDn=sD.length>=2&&sD.at(-1)>=n-10&&hs[sD.at(-1)]<hs[sD.at(-2)]&&px<Zh;
 // retest langsung di zona kuat (2+ sentuhan, searah tren) tanpa menunggu deviasi
 const zUp=tr==1&&tL>=2&&px>=L&&px<=L+bd*1.5&&!devUp,zDn=tr==-1&&tH>=2&&px<=H&&px>=H-bd*1.5&&!devDn;
 const tags=[];
 if(devUp)tags.push(tL>=2?'Three Tap':'Deviasi bawah');if(devDn)tags.push(tH>=2?'Three Top':'Deviasi atas');
 if(boUp||boDn)tags.push('Breakout-retest');if(ddUp||ddDn)tags.push('Double Deviation');if(zUp||zDn)tags.push('Retest zona kuat');if(mDevUp)tags.push('Sweep Monday Low');if(mDevDn)tags.push('Sweep Monday High');if(wDn)tags.push('Wolf bearish');if(wUp)tags.push('Wolf bullish');
 const lw=[],sw=[];
 if(ddUp)lw.push('Double Deviation: sweep ke-2 lebih dangkal, tekanan jual melemah');if(zUp)lw.push('retest zona demand kuat (2+ sentuhan, searah tren)');if(devUp)lw.push(tL>=2?'Three Tap: 2 sentuhan lalu manipulasi di bawah':'deviasi bawah lalu recovery');if(mDevUp)lw.push('sweep Monday Low lalu reclaim');if(boUp)lw.push('breakout ber-close, retest');if(wUp)lw.push('Wolf bullish: breakdown trendline gagal');if(tr==1&&nf)lw.push('Fib 0.75 tren naik');
 if(ddDn)sw.push('Double Deviation: sweep ke-2 lebih dangkal, tekanan beli melemah');if(zDn)sw.push('retest zona supply kuat (2+ sentuhan, searah tren)');if(devDn)sw.push(tH>=2?'Three Top: 2 sentuhan lalu manipulasi di atas':'deviasi atas gagal bertahan');if(mDevDn)sw.push('sweep Monday High lalu reclaim');if(boDn)sw.push('breakdown ber-close, retest');if(wDn)sw.push('Wolf: breakout trendline gagal');if(tr==-1&&nf)sw.push('Fib 0.75 tren turun');
 let side=0,why=[];
 if(lw.length&&(!sw.length||lw.length>sw.length)){side=1;why=lw}else if(sw.length){side=-1;why=sw}
 if(side==-1&&tr==1&&!devDn&&!wDn&&!mDevDn&&!ddDn)side=0;if(side==1&&tr==-1&&!devUp&&!boUp&&!wUp&&!mDevUp&&!ddUp)side=0;
 if(side&&mid&&!(side==1?devUp||mDevUp||ddUp:devDn||mDevDn||ddDn))side=0;if(flat)side=0;
 const r={px,tr,td,tw,m,flip,e20:E20,e50:E50,rsi:R[n-1],obvDiv:dO,rsiDiv:dR,ret30:px/c[n-30]-1,tags,k:k.slice(-90),off:k.length-90,H,L,zs,zr,wlow,whigh,monL,monH,pos,mid,flat,devUp,devDn,boUp,boDn,f75,qv,side};
 if(side){
  if(dO==side)why.push('OBV divergence');if(dR==side)why.push('RSI divergence');if(tr==side)why.push('searah tren');
  const trig=side==1?(ddUp?'dd':devUp?'dev':mDevUp?'mon':zUp?'zone':boUp?'bo':wUp?'wolf':'fib'):(ddDn?'dd':devDn?'dev':mDevDn?'mon':zDn?'zone':boDn?'bo':wDn?'wolf':'fib');
  const lvl=side==1?(ddUp?Zs:devUp?L:mDevUp?monL:zUp?L+bd:boUp?H:wUp?ln(TL,n):f75):(ddDn?Zh:devDn?H:mDevDn?monH:zDn?H-bd:boDn?L:wDn?ln(TH,n):f75);
  const entry=side==1?Math.min(lvl,px):Math.max(lvl,px); // limit di level retest, bukan kejar harga
  let sl=trig=='fib'?entry*(1-side*.05):trig=='dd'?(side==1?ls[sU.at(-1)]*.995:hs[sD.at(-1)]*1.005):trig=='zone'?(side==1?L*.99:H*1.01):side==1?Math.min(...rec.map(q=>q.l),cur.l)*.995:Math.max(...rec.map(q=>q.h),cur.h)*1.005;
  sl=side==1?Math.min(sl,entry*.97):Math.max(sl,entry*1.03);
  const risk=Math.abs(entry-sl),slp=risk/entry*100;
  if(trig=='wolf'){const T=side==1?TL:TH;r.tl={a:T.a,av:T.av,sl:T.sl,e:n}}
  Object.assign(r,{why,trig,entry,sl,slp,tp:entry+side*2*risk,t2:side==1?H:L,dist:Math.abs(px-entry)/px*100,type:slp<=5?'scalping':slp<=15?'swing':slp<=30&&Math.abs((side==1?H:L)-entry)/risk>=3?'spot (SL lebar)':'ditolak'})}
 return r}

export function alertList(){const d=new Date(),iso=d.toISOString().slice(0,10),md=iso.slice(5),dw=d.getUTCDay(),tm=new Date(+d+864e5),A=[];
 if(FOMC.includes(iso)||FOMC.includes(tm.toISOString().slice(0,10)))A.push(['y','FOMC hari ini atau besok: berita memicu noise. Eliz tetap hanya trading bila ada trigger jelas.','Verifikasi tanggal di federalreserve.gov']);
 if(tm.getUTCMonth()!=d.getUTCMonth())A.push(['r','Hari terakhir bulan. Penutupan bulanan 00:00 UTC.','']);
 if(dw==0)A.push(['y','Menjelang penutupan weekly (Senin 00:00 UTC).','']);
 if(HOL.includes(md))A.push(['r','Libur panjang, volume tipis. Banyak bot dan flash dump.','']);
 if(dw==1)A.push(['y','Senin: Monday range sedang terbentuk, harga cenderung kotor. Tunggu. Monday Low/High jadi level kunci minggu ini.','Dari video dan tweet']);
 return A}

// Konfirmasi timeframe rendah: retest tertahan di 4H, dan batal bila close 12H melewati SL
export async function conf(r){
 const g=async iv=>(await bj(`klines?symbol=${r.s}USDT&interval=${iv}&limit=30`)).slice(0,-1).map(a=>({h:+a[2],l:+a[3],c:+a[4]}));
 const [a,b]=await Promise.all([g('4h'),g('12h')]),s=r.side,c4=a.at(-1).c,c12=b.at(-1).c;
 if(s==1?c12<r.sl:c12>r.sl)return['bad','BATAL: close 12H melewati SL'];
 const held=a.slice(-8).some(q=>s==1?q.l<=r.entry*1.003&&q.c>r.entry:q.h>=r.entry*.997&&q.c<r.entry);
 if(s==1?c4>r.entry:c4<r.entry)return held?['ok','Retest tertahan di 4H']:['wait','Di sisi benar level, belum retest'];
 return['wait','Tunggu close 4H '+(s==1?'di atas':'di bawah')+' level']}
