import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const dataset=JSON.parse(await readFile('.local/accounting-source.json','utf8'));
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html lang="ar" dir="rtl"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><body><main id="root" style="padding:24px"></main></body></html>');return;}
  if(!/^\/pages\/[\w.-]+\.(js|mjs)$/.test(path)&&path!='/style.css'){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript; charset=utf-8');res.end(await readFile('.'+path));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(4189,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(data=>{window.fixture=data;window.notices=[];window.downloadSheets=[];window.ExcelJS={Workbook:class{constructor(){this.sheets=[];}addWorksheet(name){const rows=[];const sheet={name,rows,addRow:r=>rows.push(r),getRow:()=>({})};this.sheets.push(sheet);return sheet;}get xlsx(){return{writeBuffer:async()=>{window.downloadSheets=this.sheets.map(s=>({name:s.name,rows:s.rows.length}));return new Uint8Array([1]);}};}}};},dataset);
 await page.route('**/supabase.js?*',route=>route.fulfill({contentType:'text/javascript',body:`export const today=()=> '2026-09-26';export const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));export const toast=(m)=>window.notices.push(m);export const supabase={rpc:async(name,args)=>{if(window.failReport)return {error:{message:'test failure'}};const s=window.fixture.groups.find(g=>g.branch.id===args.target_branch).source;const sessions=s.sessions.filter(x=>x.inventory_date<=args.through_date);return {data:{...s,sessions,entries:s.entries.filter(e=>sessions.some(x=>x.id===e.session_id)),additions:s.additions.filter(x=>x.date<=args.through_date),consumption:s.consumption.filter(x=>x.date<=args.through_date)}};}};`}));
 await page.route('**/data.js?*',route=>route.fulfill({contentType:'text/javascript',body:`export const list=async type=>type==='branches'?window.fixture.groups.map(g=>g.branch):window.fixture.materials;`}));
 await page.goto('http://127.0.0.1:4189');
 await page.evaluate(async()=>{const m=await import('/pages/accounting-reports.js');await m.renderAccountingReports(document.querySelector('#root'),{role:'admin'},()=>{});});
 await page.selectOption('[name=branch]',dataset.groups.find(g=>g.branch.name==='Haram').branch.id);
 await page.click('#account-august');await page.waitForFunction(()=>document.querySelector('#account-status').textContent.includes('1 فرع'));
 assert.match(await page.locator('#account-output').innerText(),/2026-08-31/);
 await page.screenshot({path:'.local/accounting-reports-desktop.png',fullPage:true});
 for(const tab of await page.locator('[data-tab]').all()){await tab.click();assert.ok(await page.locator('#account-title').innerText());}
 await page.click('[data-download=all]');await page.waitForFunction(()=>window.downloadSheets.length===21);assert.equal((await page.evaluate(()=>window.downloadSheets)).length,21);
 const excelSource=await (await fetch('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js')).text();
 await writeFile('.local/exceljs.cjs',excelSource);
 await page.addScriptTag({content:excelSource});
 const downloadPromise=page.waitForEvent('download');await page.click('[data-download=all]');const download=await downloadPromise;await download.saveAs('.local/haram-august-reports.xlsx');
 const ExcelJS=createRequire(import.meta.url)('../.local/exceljs.cjs');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await readFile('.local/haram-august-reports.xlsx'));assert.equal(workbook.worksheets.length,21);assert.equal(workbook.worksheets[1].rowCount,103);
 const popupPromise=page.waitForEvent('popup');await page.click('#account-print');const popup=await popupPromise;await popup.waitForLoadState();assert.ok(await popup.locator('table').count());await popup.close();
 const material=dataset.groups.find(g=>g.branch.name==='Haram').source.entries[0].material_id;
 await page.selectOption('[name=material]',material);await page.click('button[type=submit]');await page.waitForTimeout(200);await page.click('[data-tab=ledger]');
 assert.ok((await page.locator('#account-output tbody tr').count())>0);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.local/accounting-reports-mobile.png',fullPage:true});
 await page.selectOption('#account-mobile-picker','dashboard');await page.locator('[data-dashboard-tab=replenishment]').first().click();assert.match(await page.locator('#account-title').innerText(),/التوريد/);await page.selectOption('#account-mobile-picker','dashboard');await page.screenshot({path:'.local/accounting-dashboard-mobile.png',fullPage:true});
 await page.selectOption('[name=material]','');await page.selectOption('[name=branch]','');await page.click('button[type=submit]');await page.waitForFunction(()=>document.querySelector('#account-status').textContent.includes('15 فرع'));
 const allDownloadPromise=page.waitForEvent('download');await page.click('[data-download=all]');await (await allDownloadPromise).saveAs('.local/all-branches-august-reports.xlsx');
 await page.evaluate(()=>window.failReport=true);await page.click('button[type=submit]');await page.waitForFunction(()=>document.querySelector('#account-status').textContent==='test failure');
 assert.match(await page.locator('#account-output').innerText(),/تعذر/);assert.deepEqual(errors,[]);
 console.log('Browser checks passed: 21 views/sheets, date/branch/material filters, real Excel round-trip, print, dashboard drill-down, mobile render, and failure without stale balances.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
