import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const app = spawn(resolve('src-tauri/target/release/magic-trackpad-battery.exe'), [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9225' }, windowsHide: true, stdio: 'ignore' });
function windows() {
  return execFileSync('pwsh', ['-NoProfile', '-Command', `
Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public class WinDump { public delegate bool Callback(IntPtr h,IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr l); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h,StringBuilder b,int n); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h,StringBuilder b,int n); public static string[] Dump(uint pid) { var result=new List<string>(); EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid){var t=new StringBuilder(512);var c=new StringBuilder(512);GetWindowTextW(h,t,512);GetClassNameW(h,c,512);result.Add(h.ToInt64()+" | "+IsWindowVisible(h)+" | "+c+" | "+t);}return true;},IntPtr.Zero);return result.ToArray(); } }';
[WinDump]::Dump(${app.pid})
`], { encoding: 'utf8' });
}
let browser;
try {
  for (let i=0;i<50;i++) { try { if ((await fetch('http://127.0.0.1:9225/json/version')).ok) break; } catch {} await sleep(300); }
  browser=await chromium.connectOverCDP('http://127.0.0.1:9225');
  let page;
  for(let i=0;i<30;i++){ page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost')); if(page)break; await sleep(300); }
  if(!page)throw Error('No native page');
  await page.getByRole('button',{name:'关闭窗口',exact:true}).waitFor();
  await page.evaluate(()=>{
    window.__closeClicks=0; window.__closeCommands=[];
    document.querySelector('.window-close').addEventListener('click',()=>window.__closeClicks++);
    const original=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=async function(command,...args){window.__closeCommands.push(command);return original.call(this,command,...args);};
  });
  console.log('BEFORE',windows());
  await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await sleep(500);
  console.log('PHYSICAL CLICK',await page.evaluate(()=>({ clicks:window.__closeClicks,commands:window.__closeCommands,visibility:document.visibilityState,text:document.querySelector('.toast')?.textContent })));
  console.log('AFTER PHYSICAL',windows());
  await page.evaluate(()=>document.querySelector('.window-close').click());
  await sleep(500);
  console.log('PROGRAMMATIC CLICK',await page.evaluate(()=>({clicks:window.__closeClicks,commands:window.__closeCommands,visibility:document.visibilityState,text:document.querySelector('.toast')?.textContent})));
  console.log('AFTER PROGRAMMATIC',windows());
} finally { if(browser)await browser.close();app.kill(); }
