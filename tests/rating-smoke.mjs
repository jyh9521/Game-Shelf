// Self-contained QA: creates its own database and server; never uses the personal library.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const dir=resolve("engineering",`rating-smoke-${Date.now()}`);
mkdirSync(dir,{recursive:true});
const token=randomBytes(24).toString("hex"),password=randomBytes(18).toString("hex");
const tokenFile=resolve(dir,"setup-token");writeFileSync(tokenFile,token);
writeFileSync(resolve(dir,"qa.db"),"");
const env={...process.env,DATABASE_URL:`file:${resolve(dir,"qa.db").replaceAll("\\","/")}`,SETUP_TOKEN_FILE:tokenFile,SETUP_TOKEN:token,APP_URL:"",SECURE_COOKIE:"false"};
execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env,stdio:"pipe"});
const reservation=createServer();await new Promise(r=>reservation.listen(0,"127.0.0.1",r));
const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{env,stdio:["ignore","pipe","pipe"],windowsHide:true});
let serverLog="";child.stdout.on("data",d=>serverLog+=d);child.stderr.on("data",d=>serverLog+=d);
let browser,cookie="",checks=0;
async function call(path,method="GET",data,status=200){
  const response=await fetch(`${base}/api/${path}`,{method,headers:{cookie,"content-type":"application/json","x-gameshelf-request":"1"},body:data===undefined?undefined:JSON.stringify(data)});
  assert.equal(response.status,status);checks++;
  if(response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie").split(";")[0];
  return response.json();
}
try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`${base}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready,"isolated QA server must become healthy");
  await call("auth/setup","POST",{username:"rating-qa",password,passwordConfirm:password,setupToken:token},201);
  const ownership={platformId:"PC",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE"};
  for(let i=1;i<=5;i++)await call("games","POST",{title:`Rating ${i}`,rating:i,status:i===5?"CLEARED":"UNPLAYED",favorite:i===5,ownership},201);
  await call("games","POST",{title:"No rating",ownership},201);
  assert.equal((await call("games?rating=")).total,6);
  for(let i=1;i<=5;i++){const result=await call(`games?rating=${i}`);assert.equal(result.total,1);assert.equal(result.items[0].title,`Rating ${i}`);}
  assert.equal((await call("games?rating=unrated")).items[0].title,"No rating");
  assert.equal((await call("games?rating=5&status=CLEARED&favorite=true&platform=PC")).total,1);
  assert.equal((await call("games?rating=4&status=CLEARED")).total,0);
  for(const rating of ["0","6","1.5","invalid"])await call(`games?rating=${rating}`,"GET",undefined,400);
  cookie="";await call("games?rating=5","GET",undefined,401);
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??"chrome",headless:true});
  const page=await browser.newPage({viewport:{width:1365,height:900}});
  await page.goto(base);await page.locator('[name="username"]').fill("rating-qa");await page.locator('[name="password"]').fill(password);
  await page.getByRole("button",{name:"登录游戏库",exact:true}).click();
  const group=page.getByRole("group",{name:"筛选个人评分"});await group.waitFor();
  await group.getByRole("button",{name:"5 星",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector(".count")?.textContent==="1");
  await page.getByRole("heading",{name:"Rating 5",exact:true}).waitFor();
  assert.equal(await group.getByRole("button",{name:"5 星",exact:true}).getAttribute("aria-pressed"),"true");
  await page.screenshot({path:resolve(dir,"desktop.png"),fullPage:true});
  await group.getByRole("button",{name:"未评分",exact:true}).click();await page.getByRole("heading",{name:"No rating",exact:true}).waitFor();
  await page.getByRole("button",{name:"重置筛选",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector(".count")?.textContent==="6");
  assert.equal(await group.getByRole("button",{name:"全部评分",exact:true}).getAttribute("aria-pressed"),"true");
  await page.setViewportSize({width:390,height:844});
  await group.getByRole("button",{name:"1 星",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector(".count")?.textContent==="1");
  await page.getByRole("heading",{name:"Rating 1",exact:true}).waitFor();
  assert.equal(await group.getByRole("button",{name:"1 星",exact:true}).getAttribute("aria-pressed"),"true");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),"mobile page has no horizontal overflow");
  await page.screenshot({path:resolve(dir,"mobile.png"),fullPage:true});
  console.log(`PASS HTTP=${checks}; UI=5-star,unrated,reset,mobile-1-star; mobile-overflow=none; personal-db=untouched`);
  console.log(`QA_ARTIFACTS=${dir}`);
}finally{
  await browser?.close();child.kill();
  writeFileSync(resolve(dir,"server.log"),serverLog);
}
