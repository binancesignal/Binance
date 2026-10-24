import { calcATR, findSwings, relativeVolume } from '../indicators.js';
import { detectFVGs } from '../fvg.js';
import { detectStructure } from '../structure.js';

const valid = (xs=[]) => xs.filter(c => [c.open,c.high,c.low,c.close].every(v => Number.isFinite(+v)));
const near = (price, level, pct) => level > 0 && Math.abs(price-level)/level <= pct;

function keyLevels(h4, d1) {
  const out=[];
  const add=(name, v, tf)=> { if (Number.isFinite(+v) && +v>0) out.push({name, price:+v, tf}); };
  const d=d1.slice(-31,-1), h=h4.slice(-43,-1);
  if(d.length){ add('Previous Day High', d.at(-1)?.high,'1D'); add('Previous Day Low',d.at(-1)?.low,'1D'); add('30D High',Math.max(...d.map(x=>+x.high)),'1D'); add('30D Low',Math.min(...d.map(x=>+x.low)),'1D'); }
  if(h.length){ add('4H Swing High',Math.max(...h.slice(-18).map(x=>+x.high)),'4H'); add('4H Swing Low',Math.min(...h.slice(-18).map(x=>+x.low)),'4H'); }
  return out;
}

function sequence(c, dir, atr) {
  const swings=findSwings(c,2,2), bull=dir==='LONG', sweepType=bull?'L':'H', breakType=bull?'H':'L';
  const piv=swings.filter(s=>s.type===sweepType && s.i<c.length-3).slice(-10).reverse();
  for(const p of piv){
    for(let i=Math.max(p.i+3,c.length-34);i<c.length-2;i++){
      const x=c[i], swept=bull ? x.low<p.price-atr*.02 && x.close>p.price : x.high>p.price+atr*.02 && x.close<p.price;
      if(!swept) continue;
      const opp=swings.filter(s=>s.type===breakType && s.i>i && s.i<c.length-1).slice(0,4);
      for(const q of opp) for(let j=q.i+2;j<c.length;j++){
        const y=c[j], body=Math.abs(y.close-y.open), broke=bull?y.close>q.price+atr*.015:y.close<q.price-atr*.015;
        if(broke && body>=atr*.18) return {sweep:{index:i,level:p.price,extreme:bull?x.low:x.high,time:x.time}, bos:{index:j,level:q.price,time:y.time}};
      }
    }
  }
  return null;
}

function poi(c, seq, dir, atr){
  const bull=dir==='LONG'; let ob=null;
  for(let i=seq.bos.index-1;i>=Math.max(seq.sweep.index,seq.bos.index-8);i--){ const x=c[i], opp=bull?x.close<x.open:x.close>x.open; if(!opp) continue; ob=bull?{low:x.low,high:Math.max(x.open,x.close)}:{low:Math.min(x.open,x.close),high:x.high}; ob={...ob,mid:(ob.low+ob.high)/2,index:i,time:x.time,type:bull?'bullish':'bearish',status:'FRESH'}; break; }
  const fvg=detectFVGs(c).filter(f=>f.type===(bull?'bullish':'bearish') && f.index>=seq.sweep.index && f.index<=seq.bos.index).at(-1)||null;
  if(!ob && fvg) ob={low:fvg.low,high:fvg.high,mid:(fvg.low+fvg.high)/2,index:fvg.index,time:fvg.time,type:fvg.type,status:'FRESH'};
  return {ob,fvg};
}

export function runCryptoConfluenceStrategy({symbol, setupCandles, h4Candles, d1Candles, price, cfg={}}){
  const c=valid(setupCandles), h4=valid(h4Candles), d1=valid(d1Candles), current=+price;
  if(c.length<60||h4.length<30||d1.length<20||!(current>0)) return [];
  const atr=calcATR(c,14); if(!(atr>0)) return [];
  const levels=keyLevels(h4,d1), h4s=detectStructure(h4), d1s=detectStructure(d1), rvol=relativeVolume(c);
  const minScore=Number.isFinite(+cfg.minScore)?+cfg.minScore:68, zonePct=Number.isFinite(+cfg.zonePct)?+cfg.zonePct:0.012;
  const out=[];
  for(const dir of ['LONG','SHORT']){
    const bull=dir==='LONG', seq=sequence(c,dir,atr); if(!seq) continue;
    const {ob,fvg}=poi(c,seq,dir,atr); if(!ob) continue;
    const anchor=seq.sweep.extreme, impulse=c[seq.bos.index]?.close; if(!Number.isFinite(+impulse)) continue;
    const range=Math.abs(impulse-anchor); const fib618=bull?impulse-range*.618:impulse+range*.618, fib786=bull?impulse-range*.786:impulse+range*.786;
    const fibLow=Math.min(fib618,fib786), fibHigh=Math.max(fib618,fib786), fibHit=ob.high>=fibLow-atr*.15 && ob.low<=fibHigh+atr*.15;
    const key=levels.filter(l=>near(ob.mid,l.price,zonePct)).sort((a,b)=>Math.abs(a.price-ob.mid)-Math.abs(b.price-ob.mid))[0]||null;
    const aligned=(bull && [h4s.bias,h4s.bos,d1s.bias,d1s.bos].includes('bullish')) || (!bull && [h4s.bias,h4s.bos,d1s.bias,d1s.bos].includes('bearish'));
    const volumeOk=rvol>=0.9;
    let score=45 + (key?16:0)+(fibHit?12:0)+(fvg?8:0)+(aligned?10:0)+(volumeOk?5:0)+(rvol>=1.25?4:0);
    score=Math.min(100,score); if(score<minScore || (!key && !fibHit)) continue;
    const buffer=Math.max(atr*.22,current*.0005), sl=bull?Math.min(ob.low,seq.sweep.extreme)-buffer:Math.max(ob.high,seq.sweep.extreme)+buffer;
    const entry=ob.mid, risk=Math.abs(entry-sl); if(!(risk>0)) continue;
    const tp1=entry+(bull?1:-1)*risk*1.5, tp2=entry+(bull?1:-1)*risk*2.5, tp3=entry+(bull?1:-1)*risk*3.5;
    if((bull && (current<=sl||current>=tp1))||(!bull&&(current>=sl||current<=tp1))) continue;
    const conf=['15m liquidity sweep','15m CHoCH/BOS close','Fresh Order Block / FVG'];
    if(key) conf.push(`${key.tf} key zone: ${key.name}`); if(fibHit) conf.push('Fib 0.618–0.786 confluence'); if(aligned) conf.push('4H/1D structure aligned'); if(volumeOk) conf.push(`Volume confirmation ${rvol.toFixed(2)}x`);
    out.push({symbol,dir,strategy:'crypto_confluence',score,qualifies:true,conf,ob,fvgs:fvg?[fvg]:[],entry,sl,tp1,tp2,tp3,rr:'1.5',price:current,rvol,atr,
      quality:{htfAligned:aligned,hasLiqEdge:true,hasSweep:true,hasFvg:!!fvg,displacement:true,fibOte:fibHit,strongSetup:true},
      metadata:{strategy:'crypto_confluence',patternTf:'15m',htf:'4h/1d',conf,ob,fvgs:fvg?[fvg]:[],rvol,cryptoConfluence:{sequence:'4H/1D KEY ZONE → LIQUIDITY SWEEP → OB/FVG → FIB → VOLUME → 15m CHoCH/BOS → ENTRY',keyZone:key,fib:{low:fibLow,high:fibHigh,hit:fibHit},h4Bias:h4s.bias,d1Bias:d1s.bias,sweep:seq.sweep,bos:seq.bos,targetSignalsPerDay:'5-10 average; market-dependent'}}});
  }
  return out.sort((a,b)=>b.score-a.score);
}
