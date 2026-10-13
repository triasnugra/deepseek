import fs from 'node:fs';
import {bj,kl,NOT,feat,alertList} from '../jurnal/core.mjs';
const F='jurnal/data/journal.json',DAY=864e5,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alerts=()=>alertList().map(a=>a[1]).join('; ');

const ELIZ=`Terapkan metode CryptoEliz:
- Ikuti tren; tren naik cari long, jangan short tanpa deviasi. BTC adalah gerbang: long altcoin saat BTC turun dihindari.
- Hanya trading di range high/low, hindari mid-range.
- Entry limit di retest setelah breakout ber-close, atau setelah deviasi (harga tembus level lalu kembali).
- Fib 0.75 zona koreksi; OBV dan RSI divergence sebagai konfirmasi.
- SL ketat (scalping 3-5%, swing 10-15%); tolak setup yang butuh SL lebih lebar.
- Saat ragu atau ada alert, NO_TRADE.`;
const prompt=(b,al,mode)=>`Kamu analis crypto. Hari ini ${new Date().toISOString().slice(0,10)} UTC. Alert aktif: ${al||'tidak ada'}.
Data harian (sudah dihitung; jangan mengarang angka lain):
${JSON.stringify(b)}
Beri rencana trading horizon 7 hari per aset. entry = harga limit. Jika tidak ada setup jelas, ada alert aktif, atau data kurang, jawab NO_TRADE. Jarak SL maks 15% dari entry.
Jawab HANYA JSON: {"hasil":[{"aset":"BTC","arah":"LONG|SHORT|NO_TRADE","entry":0,"sl":0,"tp":0,"keyakinan":0,"alasan":"maks 20 kata"}]}`+(mode=='eliz'?'\n\n'+ELIZ:'');

async function post(url,body,headers){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 if(!r.ok)throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,150));return r.json()}
const oai=(url,def,env,json)=>async(k,p)=>(await post(url,{model:process.env[env]||def,temperature:0,messages:[{role:'user',content:p}],...(json?{response_format:{type:'json_object'}}:{})},{Authorization:'Bearer '+k})).choices[0].message.content;
const AI={
 Gemini:{key:'GEMINI_API_KEY',run:async(k,p)=>(await post(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL||'gemini-2.5-flash'}:generateContent`,{contents:[{parts:[{text:p}]}],generationConfig:{temperature:0,responseMimeType:'application/json'}},{'x-goog-api-key':k})).candidates[0].content.parts[0].text},
 Groq:{key:'GROQ_API_KEY',run:oai('https://api.groq.com/openai/v1/chat/completions','llama-3.3-70b-versatile','GROQ_MODEL',true)},
 OpenRouter:{key:'OPENROUTER_API_KEY',run:oai('https://openrouter.ai/api/v1/chat/completions','meta-llama/llama-3.3-70b-instruct:free','OPENROUTER_MODEL',false)},
 Perplexity:{key:'PERPLEXITY_API_KEY',run:oai('https://api.perplexity.ai/chat/completions','sonar','PERPLEXITY_MODEL',false)}};

const rows=fs.existsSync(F)?JSON.parse(fs.readFileSync(F,'utf8')):[];
const ids=new Set(rows.map(r=>r.id)),today=new Date().toISOString().slice(0,10);
const q=v=>+Number(v).toPrecision(5);
function addRow(agen,aset,o,px,al){
 const id=`${today}|${agen}|${aset}`;if(ids.has(id))return;ids.add(id);
 const arah=String(o.arah||'').toUpperCase(),t=Date.now(),entry=+o.entry,sl=+o.sl,tp=+o.tp;
 const row={id,waktu:new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC',t,due:t+7*DAY,agen,aset,arah,entry:'',sl:'',tp:'',harga_awal:px,keyakinan:o.keyakinan??'',alasan:String(o.alasan||'').slice(0,160),alert:al,hasil:'menunggu',R:''};
 if(arah==='NO_TRADE'){row.hasil='NO_TRADE'}
 else if(arah!=='LONG'&&arah!=='SHORT'||![entry,sl,tp].every(Number.isFinite)){row.arah=arah||'?';row.hasil='tidak valid'}
 else{Object.assign(row,{entry:q(entry),sl:q(sl),tp:q(tp)});const s=arah==='LONG'?1:-1;
  if(!(s*(entry-sl)>0&&s*(tp-entry)>0)||Math.abs(entry-sl)/entry>.15)row.hasil='tidak valid'}
 rows.push(row)}
const fin=(r,h,x)=>{r.hasil=h;r.R=+x.toFixed(2)};
async function grade(r){
 const now=Date.now(),s=r.arah==='LONG'?1:-1,risk=Math.abs(r.entry-r.sl);
 const ks=(await bj(`klines?symbol=${r.aset}USDT&interval=1h&startTime=${r.t}&limit=1000`)).filter(a=>a[6]<now).map(a=>({h:+a[2],l:+a[3],c:+a[4],ct:a[6]}));
 let fill=false;
 for(const k of ks){if(k.ct>r.due)break;
  if(!fill){if(s==1?k.l<=r.entry:k.h>=r.entry)fill=true;continue}
  if(s==1?k.l<=r.sl:k.h>=r.sl)return fin(r,'SL',-1);
  if(s==1?k.h>=r.tp:k.l<=r.tp)return fin(r,'TP',s*(r.tp-r.entry)/risk)}
 if(now<r.due)return;
 const last=ks.filter(k=>k.ct<=r.due).at(-1);
 if(!fill||!last)return fin(r,'tidak terisi',0);
 fin(r,'kedaluwarsa',s*(last.c-r.entry)/risk)}

// 1) nilai prediksi lama
for(const r of rows.filter(r=>r.hasil==='menunggu')){try{await grade(r)}catch(e){console.log('nilai gagal',r.id,e.message)}}

// 2) prediksi baru (sekali sehari, setelah candle harian tutup)
const hr=new Date().getUTCHours();
if(process.env.FORCE||(hr>=1&&hr<=5)){
 const t=await bj('ticker/24hr');
 const top=t.filter(x=>x.symbol.endsWith('USDT')&&!NOT.test(x.symbol.slice(0,-4))).sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,40);
 const F40=[];
 for(let i=0;i<top.length;i+=8)await Promise.all(top.slice(i,i+8).map(async x=>{try{F40.push({s:x.symbol.slice(0,-4),...feat(await kl(x.symbol),+x.quoteVolume)})}catch(e){}}));
 const btc=F40.find(f=>f.s==='BTC'),sig=F40.filter(f=>f.side&&f.slp<=15).sort((a,b)=>b.why.length-a.why.length);
 const al=alerts(),cand=[...(btc?[btc]:[]),...sig.filter(f=>f.s!=='BTC').slice(0,5)];
 for(const f of sig)addRow('Aturan Eliz',f.s,{arah:f.side==1?'LONG':'SHORT',entry:f.entry,sl:f.sl,tp:f.tp,alasan:f.why.join(', ')},f.px,al);
 const bundle=cand.map(f=>({aset:f.s,harga:q(f.px),tren_harian:['turun','netral','naik'][f.tr+1],btc_tren:['turun','netral','naik'][(btc?.tr??0)+1],ema20:q(f.e20),ema50:q(f.e50),rsi14:Math.round(f.rsi),obv_divergence:f.obvDiv,rsi_divergence:f.rsiDiv,range60d_high:q(f.H),range60d_low:q(f.L),posisi_range_pct:Math.round(f.pos*100),fib075:q(f.f75),deviasi_bawah_5h:f.devUp,deviasi_atas_5h:f.devDn,volume24h_usd:Math.round(f.qv)}));
 const px=Object.fromEntries(cand.map(f=>[f.s,f.px]));
 if(process.env.USE_AI&&bundle.length)for(const[n,a]of Object.entries(AI)){const key=process.env[a.key];if(!key)continue;
  for(const mode of['polos','eliz']){
   try{const txt=await a.run(key,prompt(bundle,al,mode));const j=JSON.parse(txt.slice(txt.indexOf('{'),txt.lastIndexOf('}')+1));
    for(const o of j.hasil||[]){const as=String(o.aset||'').toUpperCase();if(px[as])addRow(`${n} (${mode})`,as,o,px[as],al)}
    console.log(n,mode,'ok')}catch(e){console.log(n,mode,'gagal:',e.message)}
   await sleep(2500)}}
}
fs.mkdirSync('jurnal/data',{recursive:true});
fs.writeFileSync(F,JSON.stringify(rows,null,1));
try{const g=(await (await fetch('https://api.coingecko.com/api/v3/global',{signal:AbortSignal.timeout(15000)})).json()).data.market_cap_percentage;
 const DF='jurnal/data/dominance.json',D=fs.existsSync(DF)?JSON.parse(fs.readFileSync(DF,'utf8')):[];
 if(!D.some(x=>x.d===today)){D.push({d:today,btc:+g.btc.toFixed(2),eth:+g.eth.toFixed(2)});fs.writeFileSync(DF,JSON.stringify(D.slice(-400)))}}
catch(e){console.log('dominasi gagal:',e.message)}
console.log('baris:',rows.length);
