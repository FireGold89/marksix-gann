#!/usr/bin/env node
/**
 * fetch-marksix.js — 抓取香港賽馬會最新六合彩結果，產生 data.json
 * 在 GitHub Actions 執行（Node 20+，有原生 fetch）
 *
 * 主要來源：HKJC 官方 GraphQL API（最權威）
 * 備援：lottolyzer
 */

const fs = require('fs');

const RED   = new Set([1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46]);
const BLUE  = new Set([3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48]);
const GREEN = new Set([5,6,11,16,17,21,22,27,28,32,33,38,39,43,44,49]);
function wave(n){ return RED.has(n)?'red':BLUE.has(n)?'blue':'green'; }

function entry(draw, date, main, special){
  if(!main || main.length < 6 || special == null) return null;
  main = main.map(Number).filter(n=>n>=1&&n<=49).slice(0,6).sort((a,b)=>a-b);
  if(main.length < 6) return null;
  special = Number(special);
  return { draw:String(draw), date:fmtDate(date), main, special,
    waves:{ main: main.map(wave), special: wave(special) } };
}

function fmtDate(d){
  if(!d) return '';
  if(/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0,10);
  const dt = new Date(d);
  return isNaN(dt) ? String(d).slice(0,10) : dt.toISOString().slice(0,10);
}

/* ── 來源1：HKJC 官方 GraphQL ── */
async function fromHKJC(){
  const url = 'https://info.cld.hkjc.com/graphql/base/';
  const body = {
    operationName: 'marksixResult',
    variables: { lastDrawCount: 10, drawType: 'All' },
    query: `query marksixResult($lastDrawCount: Int, $drawType: LotteryDrawType) {
      lotteryDraws(lastDrawCount: $lastDrawCount, drawType: $drawType) {
        id drawNumber drawDate
        drawResult { drawnNo }
      }
    }`
  };
  const res = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent':'Mozilla/5.0' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error(`HKJC HTTP ${res.status}`);
  const json = await res.json();
  const draws = json?.data?.lotteryDraws || [];
  if(!draws.length) throw new Error('HKJC: empty lotteryDraws');
  return draws.map(d => {
    // drawnNo: array of 7 (6 main + special) as strings/numbers
    const nums = (d.drawResult?.drawnNo || []).map(Number);
    return entry(d.drawNumber, d.drawDate, nums.slice(0,6), nums[6]);
  }).filter(Boolean);
}

/* ── 來源2：HKJC 替代 schema（部分版本欄位不同）── */
async function fromHKJC2(){
  const url = 'https://info.cld.hkjc.com/graphql/base/';
  const body = {
    query: `{ lotteryDraws(lastDrawCount: 10, drawType: All) {
      drawNumber drawDate drawResult { winNum xDrawnNo }
    } }`
  };
  const res = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent':'Mozilla/5.0' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error(`HKJC2 HTTP ${res.status}`);
  const json = await res.json();
  const draws = json?.data?.lotteryDraws || [];
  if(!draws.length) throw new Error('HKJC2: empty');
  return draws.map(d => {
    const main = String(d.drawResult?.winNum||'').split(/[+,\s]+/).map(Number).filter(Boolean);
    const special = Number(d.drawResult?.xDrawnNo);
    return entry(d.drawNumber, d.drawDate, main.slice(0,6), special);
  }).filter(Boolean);
}

/* ── 來源3：lottolyzer 網頁解析 ── */
async function fromLottolyzer(){
  const url = 'https://en.lottolyzer.com/history/hong-kong/mark-six/page/1/per-page/15/summary-view';
  const res = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0' } });
  if(!res.ok) throw new Error(`Lottolyzer HTTP ${res.status}`);
  const html = await res.text();
  // 解析表格行：尋找日期 + 號碼模式
  const results = [];
  // 每行格式類似： <td>26/063</td><td>2026-06-11</td><td>3,6,9,10,28,29</td><td>27</td>
  const rowRe = /(\d{2}\/\d{3})[\s\S]{0,80}?(\d{4}-\d{2}-\d{2})[\s\S]{0,200}?((?:\d{1,2}[,\s]+){5}\d{1,2})[\s\S]{0,60}?(\d{1,2})/g;
  let m;
  while((m = rowRe.exec(html)) !== null){
    const main = m[3].split(/[,\s]+/).map(Number).filter(Boolean);
    results.push(entry(m[1], m[2], main.slice(0,6), Number(m[4])));
  }
  const valid = results.filter(Boolean);
  if(valid.length < 2) throw new Error(`Lottolyzer: only parsed ${valid.length}`);
  return valid;
}

async function main(){
  const sources = [
    { name:'HKJC',       fn: fromHKJC },
    { name:'HKJC2',      fn: fromHKJC2 },
    { name:'Lottolyzer', fn: fromLottolyzer },
  ];

  let results = [];
  for(const s of sources){
    try {
      console.log(`\n→ Trying ${s.name}...`);
      results = await s.fn();
      if(results.length >= 2){
        console.log(`✓ ${s.name} OK — ${results.length} draws`);
        console.log(`  newest: ${results[0].draw} ${results[0].main}+${results[0].special}`);
        break;
      } else {
        console.log(`  ${s.name} returned ${results.length} (need ≥2)`);
      }
    } catch(e){
      console.log(`✗ ${s.name} failed: ${e.message}`);
    }
  }

  if(results.length < 2){
    console.error('\n✗ All sources failed. Keeping existing data.json.');
    process.exit(1);
  }

  results.sort((a,b)=> b.date.localeCompare(a.date) || b.draw.localeCompare(a.draw));

  // 與現有 data.json 比較，若最新一期相同則不更新
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync('data.json','utf8')); } catch(e){}
  if(existing && existing.latest && existing.latest.draw === results[0].draw){
    console.log(`\n= No new draw (latest still ${results[0].draw}). data.json unchanged.`);
    process.exit(0);
  }

  const output = {
    updated: new Date().toISOString(),
    latest: results[0],
    previous: results[1] || null,
    history: results.slice(0,10)
  };
  fs.writeFileSync('data.json', JSON.stringify(output,null,2));
  console.log(`\n✓ data.json updated!`);
  console.log(`  Latest:   ${output.latest.draw} — ${output.latest.main}+${output.latest.special}`);
  console.log(`  Previous: ${output.previous?.draw} — ${output.previous?.main}+${output.previous?.special}`);
}

main().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
