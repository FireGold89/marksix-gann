#!/usr/bin/env node
/**
 * fetch-marksix.js — 抓取香港賽馬會最新六合彩結果，產生 data.json
 * 在 GitHub Actions 執行（Node 20+）
 *
 * 主要來源：HKJC 官方 GraphQL（正確解析 drawResult.drawnNo 結構）
 * drawnNo 結構：每個元素 { no: "03", color: "..." }，最後一個 isSpecial / 第7個為特別號
 */

const fs = require('fs');

const RED   = new Set([1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46]);
const BLUE  = new Set([3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48]);
const GREEN = new Set([5,6,11,16,17,21,22,27,28,32,33,38,39,43,44,49]);
function wave(n){ return RED.has(n)?'red':BLUE.has(n)?'blue':'green'; }

function makeEntry(draw, date, main, special){
  if(!main || special == null) return null;
  main = [...new Set(main.map(Number).filter(n=>n>=1&&n<=49))].sort((a,b)=>a-b);
  special = Number(special);
  if(main.length !== 6 || !(special>=1&&special<=49)) return null;
  if(main.includes(special)) return null; // sanity: special can't be in main
  return { draw:String(draw), date:fmtDate(date), main, special,
    waves:{ main: main.map(wave), special: wave(special) } };
}
function fmtDate(d){
  if(!d) return '';
  if(/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0,10);
  const dt = new Date(d);
  return isNaN(dt) ? String(d).slice(0,10) : dt.toISOString().slice(0,10);
}

/* ── HKJC 官方 GraphQL ── */
async function fromHKJC(){
  const url = 'https://info.cld.hkjc.com/graphql/base/';
  const body = {
    query: `{ lotteryDraws(lastDrawCount: 12, drawType: All) {
      drawNumber
      drawDate
      drawResult {
        drawnNo
      }
    } }`
  };
  const res = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent':'Mozilla/5.0' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error(`HKJC HTTP ${res.status}`);
  const json = await res.json();
  console.log('  HKJC raw sample:', JSON.stringify(json?.data?.lotteryDraws?.[0]));
  const draws = json?.data?.lotteryDraws || [];
  if(!draws.length) throw new Error('empty lotteryDraws');

  return draws.map(d => {
    let arr = d.drawResult?.drawnNo;
    // drawnNo 可能是 array of numbers, array of strings, or array of objects
    let nums = [];
    if(Array.isArray(arr)){
      nums = arr.map(x => {
        if(typeof x === 'object' && x !== null) return Number(x.no ?? x.number ?? x.value);
        return Number(x);
      }).filter(n=>!isNaN(n));
    } else if(typeof arr === 'string'){
      nums = arr.split(/[,+\s]+/).map(Number).filter(n=>!isNaN(n));
    }
    // 香港六合彩標準：7個號碼，第7個（最後）為特別號
    // 但 drawnNo 可能含重複或非標準排序 → 取前7個唯一值
    if(nums.length < 7) return null;
    const seven = nums.slice(0,7);
    const main = seven.slice(0,6);
    const special = seven[6];
    return makeEntry(d.drawNumber, d.drawDate, main, special);
  }).filter(Boolean);
}

/* ── 備援：lottolyzer JSON-ish ── */
async function fromLottolyzer(){
  const url = 'https://en.lottolyzer.com/history/hong-kong/mark-six/page/1/per-page/15/summary-view';
  const res = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0' } });
  if(!res.ok) throw new Error(`Lottolyzer HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const rowRe = /(\d{2}\/\d{3})[\s\S]{0,80}?(\d{4}-\d{2}-\d{2})[\s\S]{0,200}?((?:\d{1,2}[,\s]+){5}\d{1,2})[\s\S]{0,60}?(\d{1,2})/g;
  let m;
  while((m = rowRe.exec(html)) !== null){
    const main = m[3].split(/[,\s]+/).map(Number).filter(Boolean).slice(0,6);
    results.push(makeEntry(m[1], m[2], main, Number(m[4])));
  }
  const valid = results.filter(Boolean);
  if(valid.length < 2) throw new Error(`only parsed ${valid.length}`);
  return valid;
}

async function main(){
  const sources = [
    { name:'HKJC',       fn: fromHKJC },
    { name:'Lottolyzer', fn: fromLottolyzer },
  ];
  let results = [];
  for(const s of sources){
    try {
      console.log(`\n→ Trying ${s.name}...`);
      results = await s.fn();
      if(results.length >= 2){
        console.log(`✓ ${s.name} OK — ${results.length} valid draws`);
        console.log(`  newest: ${results[0].draw} ${results[0].main}+${results[0].special}`);
        break;
      } else {
        console.log(`  ${s.name}: only ${results.length} valid`);
      }
    } catch(e){
      console.log(`✗ ${s.name}: ${e.message}`);
    }
  }
  if(results.length < 2){
    console.error('\n✗ All sources failed. Keeping existing data.json.');
    process.exit(1);
  }

  results.sort((a,b)=> b.date.localeCompare(a.date) || b.draw.localeCompare(a.draw));

  let existing = null;
  try { existing = JSON.parse(fs.readFileSync('data.json','utf8')); } catch(e){}
  if(existing?.latest?.draw === results[0].draw){
    console.log(`\n= No new draw (latest still ${results[0].draw}). Unchanged.`);
    process.exit(0);
  }

  const output = {
    updated: new Date().toISOString(),
    latest: results[0],
    previous: results[1] || null,
    history: results.slice(0,10)
  };
  fs.writeFileSync('data.json', JSON.stringify(output,null,2));
  console.log(`\n✓ data.json updated! Latest ${output.latest.draw}`);
}

main().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
