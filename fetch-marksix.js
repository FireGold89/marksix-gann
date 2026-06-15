#!/usr/bin/env node
/**
 * fetch-marksix.js
 * 在 GitHub Actions 中執行，抓取香港賽馬會最新六合彩結果
 * 並產生 data.json 供前端使用
 *
 * 資料來源（多個備援）：
 *  1. lottolyzer.com (結構化，最穩定)
 *  2. HKJC 官方 (備援)
 */

const fs = require('fs');

// 波色定義
const RED   = new Set([1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46]);
const BLUE  = new Set([3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48]);
const GREEN = new Set([5,6,11,16,17,21,22,27,28,32,33,38,39,43,44,49]);
function wave(n){ return RED.has(n)?'red':BLUE.has(n)?'blue':'green'; }

async function fetchJSON(url, opts={}) {
  const res = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0' }, ...opts });
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * 來源1：lottolyzer 歷史資料 (CSV-like JSON endpoint)
 */
async function fromLottolyzer() {
  const url = 'https://en.lottolyzer.com/api/v1/result/hong-kong/mark-six/page/1/per-page/10';
  const txt = await fetchJSON(url);
  const data = JSON.parse(txt);
  // 預期結構：{ "results": [ { "draw":"26/063", "date":"2026-06-11", "winning-numbers":"3,6,9,10,28,29", "bonus":"27" }, ... ] }
  const list = data.results || data.data || [];
  return list.map(r => parseEntry(
    r.draw || r['draw-number'] || r.drawNo,
    r.date || r['draw-date'],
    (r['winning-numbers'] || r.numbers || '').split(/[,\s]+/).map(Number).filter(Boolean),
    Number(r.bonus || r['special-number'] || r.special)
  )).filter(Boolean);
}

/**
 * 來源2：HKJC 官方 JSON API
 */
async function fromHKJC() {
  const url = 'https://info.cld.hkjc.com/graphql/base/';
  const query = {
    query: `{ lotteryDraw(lotteryType: MarkSix, drawType: All, count: 10) {
      drawNumber drawDate drawResult { winningNumbers drawnNumbers } }
    }`
  };
  const txt = await fetchJSON(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(query)
  });
  const data = JSON.parse(txt);
  const draws = data?.data?.lotteryDraw || [];
  return draws.map(d => {
    const nums = (d.drawResult?.drawnNumbers || d.drawResult?.winningNumbers || []).map(Number);
    const main = nums.slice(0,6);
    const special = nums[6];
    return parseEntry(d.drawNumber, d.drawDate, main, special);
  }).filter(Boolean);
}

function parseEntry(drawNo, date, main, special) {
  if(!main || main.length < 6 || !special) return null;
  main = main.slice(0,6).sort((a,b)=>a-b);
  return {
    draw: String(drawNo),
    date: formatDate(date),
    main,
    special,
    waves: {
      main: main.map(wave),
      special: wave(special)
    }
  };
}

function formatDate(d) {
  if(!d) return '';
  // 標準化為 YYYY-MM-DD
  const dt = new Date(d);
  if(!isNaN(dt)) return dt.toISOString().slice(0,10);
  return String(d).slice(0,10);
}

async function main() {
  let results = [];
  const sources = [
    { name:'lottolyzer', fn: fromLottolyzer },
    { name:'hkjc',       fn: fromHKJC },
  ];

  for(const src of sources){
    try {
      console.log(`Trying source: ${src.name}...`);
      results = await src.fn();
      if(results.length >= 2){
        console.log(`✓ ${src.name} returned ${results.length} draws`);
        break;
      }
    } catch(e) {
      console.log(`✗ ${src.name} failed: ${e.message}`);
    }
  }

  if(results.length < 2){
    console.error('All sources failed or insufficient data. Keeping existing data.json.');
    process.exit(1);
  }

  // 排序：最新在前
  results.sort((a,b) => b.date.localeCompare(a.date) || b.draw.localeCompare(a.draw));

  const output = {
    updated: new Date().toISOString(),
    latest: results[0],
    previous: results[1] || null,
    history: results.slice(0, 10)
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`\n✓ data.json written.`);
  console.log(`  Latest:   ${output.latest.draw} (${output.latest.date}) — ${output.latest.main.join(',')} + ${output.latest.special}`);
  console.log(`  Previous: ${output.previous?.draw} — ${output.previous?.main.join(',')} + ${output.previous?.special}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
