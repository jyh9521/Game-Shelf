// Release QA uses disposable named containers/volumes, never existing personal data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync,writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
const dir=resolve("engineering/release-0.1.3");mkdirSync(dir,{recursive:true});
const id=`gs-release-013-${Date.now()}`,old="jyh9521/gameshelf:0.1.2",image="jyh9521/gameshelf:0.1.3";
const names={baseline:`${id}-baseline`,modified:`${id}-modified`,rollback:`${id}-rollback`};
const volumes={baseline:`${id}-baseline`,modified:`${id}-modified`,rollback:`${id}-rollback`};
const password=randomBytes(24).toString("hex");let base="",cookie="",browser,checks=0;
const records=[];
function docker(...args){return execFileSync("docker",args,{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],maxBuffer:16*1024*1024}).trim();}
function log(line){records.push(line);console.log(line);}
async function start(which,tag){
  if(which==="rollback")execFileSync("C:/Program Files/Git/bin/bash.exe",[resolve(dir,"ROLLBACK.sh"),names[which],volumes[which]],{stdio:"pipe",windowsHide:true});
  else docker("run","-d","--name",names[which],"--label","gameshelf.qa=release-0.1.3","-p","127.0.0.1::3000","-e","PUID=99","-e","PGID=100","-v",`${volumes[which]}:/data`,tag);
  const port=docker("port",names[which],"3000/tcp").split(":").at(-1);base=`http://127.0.0.1:${port}`;
  let healthy=false;for(let i=0;i<180;i++){try{if((await fetch(`${base}/api/health`)).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  assert.ok(healthy,`${which} healthy; ${docker("logs",names[which])}`);
  assert.equal(docker("exec",names[which],"node","-e","console.log(require('fs').readFileSync('/proc/1/status','utf8').match(/Uid:\\s+(\\d+)/)[1])"),"99");
}
function clone(from,to){
  docker("volume","create",to);
  docker("run","--rm","--label","gameshelf.qa=release-0.1.3","-v",`${from}:/from:ro`,"-v",`${to}:/to`,"node:24-bookworm-slim","node","-e","const f=require('fs');f.cpSync('/from','/to',{recursive:true});for(const p of f.readdirSync('/to'))f.chownSync('/to/'+p,99,100);f.chownSync('/to',99,100)");
}
async function call(path,method="GET",data,status=200){
  const response=await fetch(`${base}/api/${path}`,{method,headers:{cookie,"content-type":"application/json","x-gameshelf-request":"1"},body:data===undefined?undefined:JSON.stringify(data)});
  assert.equal(response.status,status,`${method} ${path}`);checks++;
  if(response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie").split(";")[0];return response.json();
}
async function backup(){const value=await call("backup");delete value.exportedAt;for(const v of Object.values(value))if(Array.isArray(v))v.sort((a,b)=>a.id.localeCompare(b.id));return value;}
async function healthStatus(name){for(let i=0;i<80;i++){const status=docker("inspect","--format","{{.State.Health.Status}}",name);if(status==="healthy")return status;await new Promise(r=>setTimeout(r,500));}throw Error("Docker healthcheck not healthy");}
try{
  for(const v of Object.values(volumes))docker("volume","create",v);
  await start("baseline",old);
  const token=docker("exec",names.baseline,"cat","/data/setup-token");
  await call("auth/setup","POST",{username:"release-qa",password,passwordConfirm:password,setupToken:token},201);
  const ownership={platformId:"PC",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE"};
  const created=[];for(let i=1;i<=5;i++)created.push(await call("games","POST",{title:`Release rating ${i}`,rating:i,status:i===5?"CLEARED":"UNPLAYED",favorite:i===5,ownership},201));
  await call("games","POST",{title:"Release unrated",ownership},201);
  assert.equal((await call("games?rating=5")).total,6);
  const original=await backup();writeFileSync(resolve(dir,"baseline-backup.json"),JSON.stringify(original,null,2));
  log("BASELINE PASS: image=0.1.2; input=rating=5; result=6 (filter ignored); games=6; uid=99; exit=0");
  docker("stop",names.baseline);clone(volumes.baseline,volumes.modified);clone(volumes.baseline,volumes.rollback);
  await start("modified",image);
  assert.deepEqual(await backup(),original);log("UPGRADE PASS: database backup identical; existing session preserved; uid=99; exit=0");
  for(let i=1;i<=5;i++){const result=await call(`games?rating=${i}`);assert.equal(result.total,1);assert.equal(result.items[0].title,`Release rating ${i}`);}
  assert.equal((await call("games?rating=unrated")).total,1);
  assert.equal((await call("games?rating=")).total,6);
  assert.equal((await call("games?rating=5&status=CLEARED&favorite=true&platform=PC")).total,1);
  assert.equal((await call("games?rating=4&status=CLEARED")).total,0);
  for(const rating of ["0","6","1.5","invalid"])await call(`games?rating=${rating}`,"GET",undefined,400);
  const session=cookie;cookie="";await call("games?rating=5","GET",undefined,401);cookie=session;
  browser=await chromium.launch({channel:"chrome",headless:true});
  const page=await browser.newPage({viewport:{width:1365,height:900}});await page.goto(base);
  await page.locator('[name="username"]').fill("release-qa");await page.locator('[name="password"]').fill(password);await page.getByRole("button",{name:"登录游戏库",exact:true}).click();
  await page.getByText("LOCAL-FIRST / v0.1.3",{exact:true}).waitFor();
  const group=page.getByRole("group",{name:"筛选个人评分"});await group.getByRole("button",{name:"5 星",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector(".count")?.textContent==="1");await page.getByRole("heading",{name:"Release rating 5",exact:true}).waitFor();
  await page.screenshot({path:resolve(dir,"desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});await group.getByRole("button",{name:"未评分",exact:true}).click();await page.getByRole("heading",{name:"Release unrated",exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:resolve(dir,"mobile.png"),fullPage:true});
  await page.getByRole("button",{name:"重置筛选",exact:true}).click();await page.waitForFunction(()=>document.querySelector(".count")?.textContent==="6");
  await browser.close();browser=null;
  await call(`games/${created[3].id}`,"PUT",{title:"Release rating 4 edited",rating:5});
  assert.equal((await call("games?rating=5")).total,2);const modified=await backup();
  log(`MODIFIED PASS: image=0.1.3; input=rating=5; result=1 before edit,2 after edit; UI=desktop,mobile,reset; health=${await healthStatus(names.modified)}; exit=0`);
  docker("stop",names.modified);docker("rm",names.modified);await start("modified",image);
  assert.deepEqual(await backup(),modified);log("PERSISTENCE PASS: removed/recreated container; edited data and session identical; exit=0");
  await start("rollback",old);assert.deepEqual(await backup(),original);assert.equal((await call("games?rating=5")).total,6);
  log("ROLLBACK PASS: image=0.1.2 + pre-upgrade snapshot on separate volume; original data/session restored; rating=5 result=6 (filter ignored); exit=0");
  writeFileSync(resolve(dir,"container-qa.json"),JSON.stringify({names,volumes,checks,imageId:docker("image","inspect",image,"--format","{{.Id}}"),records},null,2));
  log(`PASS RELEASE QA: HTTP=${checks}; no personal volumes used; old image retained`);
}finally{
  await browser?.close();
  for(const name of Object.values(names)){
    try{writeFileSync(resolve(dir,`${name}.log`),docker("logs",name));docker("stop",name);docker("rm",name);}catch{}
  }
  writeFileSync(resolve(dir,"container-qa.txt"),records.join("\n")+"\n");
}
