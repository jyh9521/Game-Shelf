// Real Docker upgrade/rollback proof, using only newly-created labeled QA volumes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";

const dir=resolve(process.env.RELEASE_QA_DIR??"engineering/release-0.1.5");mkdirSync(dir,{recursive:true});
const id=`gs-release-015-${Date.now()}`,label="release-0.1.5";
const old="jyh9521/gameshelf@sha256:180adfeb302b433cab64ff956943569222f9170d0df3dc63f3387b55602c8b5b";
const image=process.env.TEST_IMAGE??"jyh9521/gameshelf:0.1.5";
const names=Object.fromEntries(["baseline","modified","rollback"].map(k=>[k,`${id}-${k}`]));
const volumes=Object.fromEntries(["baseline","modified","rollback","fresh","symlink"].map(k=>[k,`${id}-${k}`]));
const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],maxBuffer:16*1024*1024}).trim();
const records=[];const log=s=>{records.push(s);console.log(s);};
const password=randomBytes(24).toString("hex");let base="",cookie="",browser,checks=0;
function helper(volume,code){return docker("run","--rm","--label",`gameshelf.qa=${label}`,"--entrypoint","node","-v",`${volume}:/data`,old,"-e",code);}
function clone(from,to){docker("run","--rm","--label",`gameshelf.qa=${label}`,"--entrypoint","sh","-v",`${from}:/from:ro`,"-v",`${to}:/to`,old,"-c","cp -a /from/. /to/");}
function fileStats(volume){return JSON.parse(helper(volume,"const f=require('fs'),c=require('crypto');const out={};for(const n of ['setup-token','gameshelf.db','unrelated.txt','nested/unrelated.txt']){const p='/data/'+n,s=f.statSync(p);out[n]={uid:s.uid,gid:s.gid,mode:s.mode&511,sha256:c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}}console.log(JSON.stringify(out))"));}
const rollbackScript=resolve(dir,"ROLLBACK.sh");
writeFileSync(rollbackScript,`#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1
NAME="\${1:?isolated QA container name}"
VOLUME="\${2:?isolated pre-upgrade snapshot volume}"
case "$NAME:$VOLUME" in gs-release-015-*:gs-release-015-*) ;; *) echo "Expected isolated release QA names" >&2; exit 2;; esac
[[ "$(docker volume inspect --format '{{index .Labels "gameshelf.qa"}}' "$VOLUME")" == "release-0.1.5" ]]
docker run -d --name "$NAME" --label gameshelf.qa=release-0.1.5 -p 127.0.0.1::3000 -e PUID=99 -e PGID=100 --mount "type=volume,source=$VOLUME,target=/data" ${old} >/dev/null
echo "ROLLBACK_STARTED image=0.1.4 snapshot=isolated"
`);chmodSync(rollbackScript,0o755);
async function start(which,tag){
  if(which==="rollback"){
    const bash=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"bash";
    const output=execFileSync(bash,[rollbackScript,names[which],volumes[which]],{encoding:"utf8",windowsHide:true});
    assert.equal(output.trim(),"ROLLBACK_STARTED image=0.1.4 snapshot=isolated");
  }else docker("run","-d","--name",names[which],"--label",`gameshelf.qa=${label}`,"-p","127.0.0.1::3000","-e","PUID=99","-e","PGID=100","-v",`${volumes[which]}:/data`,tag);
  base=`http://127.0.0.1:${docker("port",names[which],"3000/tcp").split(":").at(-1)}`;
  let ready=false;for(let i=0;i<120;i++){
    try{if((await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}
    if(docker("inspect","--format","{{.State.Running}}",names[which])!=="true")break;
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(ready,`${which} startup: ${docker("logs",names[which])}`);
  assert.equal(docker("exec",names[which],"node","-e","console.log(require('fs').readFileSync('/proc/1/status','utf8').match(/Uid:\\s+(\\d+)/)[1])"),"99");
}
async function healthStatus(name){
  for(let i=0;i<90;i++){if(docker("inspect","--format","{{.State.Health.Status}}",name)==="healthy")return "healthy";await new Promise(r=>setTimeout(r,500));}
  throw Error("Docker HEALTHCHECK timeout");
}
async function call(path,method="GET",data,status=200){
  const r=await fetch(`${base}/api/${path}`,{method,signal:AbortSignal.timeout(10000),headers:{cookie,"content-type":"application/json","x-gameshelf-request":"1"},body:data===undefined?undefined:JSON.stringify(data)});
  const b=await r.json();assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(b)}`);checks++;
  if(r.headers.get("set-cookie"))cookie=r.headers.get("set-cookie").split(";")[0];return b;
}
async function backup(){const b=await call("backup");delete b.exportedAt;for(const v of Object.values(b))if(Array.isArray(v))v.sort((a,b)=>a.id.localeCompare(b.id));return b;}
async function matches(params,ids){const data=await call(`games?${new URLSearchParams(params)}`);assert.equal(data.total,ids.length);assert.deepEqual(data.items.map(g=>g.id).sort(),ids.slice().sort());return data;}
function failure(volume){return spawnSync("docker",["run","--rm","--label",`gameshelf.qa=${label}`,"-e","PUID=99","-e","PGID=100","-v",`${volume}:/data`,image,"node","-e","console.log('UNEXPECTED_START')"],{encoding:"utf8",windowsHide:true});}

try{
  for(const v of Object.values(volumes))docker("volume","create","--label",`gameshelf.qa=${label}`,v);
  await start("baseline",old);
  const token=docker("exec",names.baseline,"cat","/data/setup-token");
  await call("auth/setup","POST",{username:"release-qa",password,passwordConfirm:password,setupToken:token},201);
  const owned={platformId:"PC",storeId:"STEAM",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE"};
  const physical={...owned,platformId:"PS4",storeId:"PHYSICAL",mediaType:"PHYSICAL"};
  const add=(title,genre,releaseDate,extra={},ownership=owned)=>call("games","POST",{title,genre,...extra,ownership:{...ownership,releaseDate}},201);
  const a=await add("Release RPG PC","RPG","2005",{rating:5,status:"CLEARED",favorite:true});
  await call(`games/${a.id}/items`,"POST",{...physical,releaseDate:"2010-03",acquisitionType:"BORROWED",accessStatus:"RETURNED"},201);
  const b=await add("Release RPG Switch","RPG","2005-11",{rating:4},{...physical,platformId:"NS1"});
  const c=await add("Release action","动作 / 冒险","2020-02-29",{rating:3});
  const d=await add("Release unknown","","");
  const e=await add("Release named unknown","unknown","2005-12-01");
  const f=await add("Release RPG no date","RPG","",{},physical);
  assert.equal((await call("games?genre=RPG&year=2005")).total,6);
  assert.equal((await call("games?platform=PS4&year=2005")).total,2);
  const original=await backup();assert.equal(original.schema_version,1);
  writeFileSync(resolve(dir,"baseline-backup.json"),JSON.stringify(original,null,2));
  log("BASELINE PASS image=0.1.4 input=genre:RPG,year:2005 result=6 filters=ignored uid=99 exit=0");
  docker("stop",names.baseline);
  // Preserve real legacy ownership in both copied snapshots; never normalize during clone.
  helper(volumes.baseline,"const f=require('fs');f.chownSync('/data/setup-token',0,0);f.chmodSync('/data/setup-token',384);f.chownSync('/data/gameshelf.db',1000,1000);f.chmodSync('/data/gameshelf.db',384);f.writeFileSync('/data/unrelated.txt','keep',{mode:384});f.mkdirSync('/data/nested');f.writeFileSync('/data/nested/unrelated.txt','nested keep',{mode:384})");
  const before=fileStats(volumes.baseline);assert.equal(before['setup-token'].uid,0);assert.equal(before['gameshelf.db'].uid,1000);
  clone(volumes.baseline,volumes.modified);clone(volumes.baseline,volumes.rollback);
  assert.deepEqual(fileStats(volumes.modified),before);assert.deepEqual(fileStats(volumes.rollback),before);
  await start("modified",image);assert.deepEqual(await backup(),original);
  const after=fileStats(volumes.modified);
  for(const name of ["setup-token","gameshelf.db"]){assert.equal(after[name].uid,99);assert.equal(after[name].gid,100);assert.equal(after[name].mode,384);}
  assert.equal(after['setup-token'].sha256,before['setup-token'].sha256);
  for(const name of ['unrelated.txt','nested/unrelated.txt'])assert.deepEqual(after[name],before[name]);
  assert.equal(docker("exec",names.modified,"node","-p","require('./package.json').version"),"0.1.5");
  log("UPGRADE PASS data=identical session=preserved token=unchanged owner=99:100 mode=600 unrelated=unchanged exit=0");
  await matches({genre:"RPG",year:"2005"},[a.id,b.id]);
  await matches({genre:"RPG",year:"2005",platform:"PC",rating:"5",status:"CLEARED",favorite:"true"},[a.id]);
  await matches({year:"2005",platform:"PS4"},[]);
  await matches({year:"2010",store:"STEAM"},[]);await matches({year:"2010",mediaType:"DIGITAL"},[]);
  await matches({year:"unknown"},[d.id,f.id]);await matches({unclassified:"true"},[d.id]);await matches({genre:"unknown"},[e.id]);
  await matches({year:"2020"},[c.id]);
  assert.deepEqual((await call("games?q=absent")).filters,{genres:["动作 / 冒险","RPG","unknown"],years:["2020","2010","2005"]});
  for(const query of ["year=0000","year=2005-01","genre=RPG&unclassified=true","rating=6"])await call(`games?${query}`,"GET",undefined,400);
  const session=cookie;cookie="";await call("games?year=2005","GET",undefined,401);cookie=session;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==="win32"&&existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")?"msedge":undefined);
  browser=await chromium.launch({channel,headless:true});
  const page=await browser.newPage({viewport:{width:1365,height:1000}});
  await page.goto(base);await page.locator('[name="username"]').fill("release-qa");await page.locator('[name="password"]').fill(password);
  await page.getByRole("button",{name:"登录游戏库",exact:true}).click();await expect(page.getByText("LOCAL-FIRST / v0.1.5",{exact:true})).toBeVisible();
  const genres=page.getByRole("group",{name:"筛选游戏类型"}),years=page.getByRole("group",{name:"筛选拥有版本发售年份"});
  await genres.getByRole("button",{name:"类型：RPG",exact:true}).click();await years.getByRole("button",{name:"2005",exact:true}).click();
  await expect(page.locator(".count")).toHaveText("2");await page.screenshot({path:resolve(dir,"desktop.png"),fullPage:true});
  await page.getByRole("button",{name:"重置筛选",exact:true}).click();await expect(page.locator(".count")).toHaveText("6");
  await page.setViewportSize({width:390,height:844});await genres.getByRole("button",{name:"未分类",exact:true}).click();await years.getByRole("button",{name:"年份未知",exact:true}).click();
  await expect(page.locator(".count")).toHaveText("1");await expect(page.getByRole("heading",{name:"Release unknown",exact:true})).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(dir,"mobile.png"),fullPage:true});
  await browser.close();browser=undefined;
  await call(`games/${a.id}`,"PUT",{title:"Release RPG PC edited",genre:"RPG",rating:5,status:"CLEARED",favorite:true,memo:"Persist after upgrade"});
  await add("Release new after upgrade","策略","2024");const modified=await backup();
  log(`MODIFIED PASS image=0.1.5 input=genre:RPG,year:2005 result=2 UI=desktop,mobile,reset health=${await healthStatus(names.modified)} exit=0`);
  docker("stop",names.modified);docker("rm",names.modified);await start("modified",image);
  assert.deepEqual(await backup(),modified);assert.equal((await call("games")).total,7);
  log("PERSISTENCE PASS recreated=0.1.5 games=7 edited-data=preserved session=preserved exit=0");
  await start("rollback",old);assert.deepEqual(await backup(),original);assert.equal((await call("games?genre=RPG&year=2005")).total,6);
  log("ROLLBACK PASS image=0.1.4 snapshot=isolated games=6 data=original session=preserved filters=ignored exit=0");
  const fresh=docker("run","--rm","--label",`gameshelf.qa=${label}`,"-e","PUID=1000","-e","PGID=1000","-v",`${volumes.fresh}:/data`,image,"node","-e","console.log('FRESH_STARTUP_OK uid='+process.getuid())");
  assert.match(fresh,/FRESH_STARTUP_OK uid=1000/);log("FRESH PASS FRESH_STARTUP_OK uid=1000 exit=0");
  helper(volumes.symlink,"const f=require('fs');f.writeFileSync('/data/unrelated.txt','unchanged',{mode:384});f.symlinkSync('/data/unrelated.txt','/data/setup-token')");
  const linkBefore=helper(volumes.symlink,"const s=require('fs').statSync('/data/unrelated.txt');console.log(s.uid+':'+s.gid+':'+s.mode)");
  const link=failure(volumes.symlink);assert.equal(link.status,1);assert.match(link.stderr,/must not be a symbolic link/);
  assert.equal(helper(volumes.symlink,"const s=require('fs').statSync('/data/unrelated.txt');console.log(s.uid+':'+s.gid+':'+s.mode)"),linkBefore);
  log("SYMLINK PASS rejected=expected container-exit=1 target=unchanged");
  writeFileSync(resolve(dir,"fixture-hashes.json"),JSON.stringify({before,after,volumes},null,2));
  writeFileSync(resolve(dir,"container-qa.json"),JSON.stringify({image,old,names,volumes,checks,imageId:docker("image","inspect",image,"--format","{{.Id}}"),records},null,2));
  log(`RELEASE PASS HTTP=${checks} personal-data=untouched baseline=pass modified=pass rollback=pass`);
}finally{
  await browser?.close();
  for(const name of Object.values(names)){
    try{writeFileSync(resolve(dir,`${name}.log`),docker("logs",name));docker("stop",name);docker("rm",name);}catch{}
  }
  for(const v of Object.values(volumes)){try{docker("volume","rm",v);}catch{}}
  writeFileSync(resolve(dir,"container-qa.txt"),records.join("\n")+"\n");
}
