// Reproduces legacy ownership without normalizing it during snapshot copy.
import assert from "node:assert/strict";
import { execFileSync,spawnSync } from "node:child_process";
import { mkdirSync,writeFileSync,chmodSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
const dir=resolve("engineering/startup-fix-0.1.4");mkdirSync(dir,{recursive:true});
const id=`gs-permission-${Date.now()}`,old="jyh9521/gameshelf:0.1.3",image=process.env.TEST_IMAGE??"jyh9521/gameshelf:0.1.4";
const volumes=Object.fromEntries(["original","bad","modified","rollback","fresh","symlink"].map(k=>[k,`${id}-${k}`]));
const containers=[],records=[];let base="",cookie="",browser;
const password=randomBytes(24).toString("hex");
const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],maxBuffer:16*1024*1024}).trim();
const log=s=>{records.push(s);console.log(s);};
function helper(volume,code){return docker("run","--rm","--entrypoint","node","-v",`${volume}:/data`,old,"-e",code);}
function clone(from,to){docker("run","--rm","--entrypoint","sh","-v",`${from}:/from:ro`,"-v",`${to}:/to`,old,"-c","cp -a /from/. /to/");}
function inspect(volume){return JSON.parse(helper(volume,"const f=require('fs'),c=require('crypto');const out={};for(const name of ['setup-token','gameshelf.db','unrelated.txt','nested/unrelated.txt']){const p='/data/'+name,s=f.statSync(p);out[name]={uid:s.uid,gid:s.gid,mode:s.mode&511,hash:c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}}console.log(JSON.stringify(out))"));}
async function start(name,volume,tag,uid="99",gid="100"){
  docker("run","-d","--name",name,"--label","gameshelf.qa=startup-0.1.4","-p","127.0.0.1::3000","-e",`PUID=${uid}`,"-e",`PGID=${gid}`,"-v",`${volume}:/data`,tag);containers.push(name);
  base=`http://127.0.0.1:${docker("port",name,"3000/tcp").split(":").at(-1)}`;
  for(let i=0;i<120;i++){try{if((await fetch(`${base}/api/health`)).ok)return;}catch{}if(docker("inspect","--format","{{.State.Running}}",name)==="false")throw Error(docker("logs",name));await new Promise(r=>setTimeout(r,500));}
  throw Error("health timeout");
}
async function call(path,method="GET",data,status=200){
  const r=await fetch(`${base}/api/${path}`,{method,headers:{cookie,"content-type":"application/json","x-gameshelf-request":"1"},body:data===undefined?undefined:JSON.stringify(data)});
  assert.equal(r.status,status,`${method} ${path}`);if(r.headers.get("set-cookie"))cookie=r.headers.get("set-cookie").split(";")[0];return r.json();
}
async function backup(){const b=await call("backup");delete b.exportedAt;for(const v of Object.values(b))if(Array.isArray(v))v.sort((a,b)=>a.id.localeCompare(b.id));return b;}
function failure(volume,tag){return spawnSync("docker",["run","--rm","-e","PUID=99","-e","PGID=100","-v",`${volume}:/data`,tag,"node","-e","console.log('STARTUP_OK')"],{encoding:"utf8"});}
try{
  for(const v of Object.values(volumes))docker("volume","create",v);
  const first=`${id}-seed`;await start(first,volumes.original,old,"1000","1000");
  const token=docker("exec",first,"cat","/data/setup-token");
  await call("auth/setup","POST",{username:"permission-qa",password,passwordConfirm:password,setupToken:token},201);
  const ownership={platformId:"PC",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE",manualTotalOverride:3600};
  await call("games","POST",{title:"Existing collection",rating:5,memo:"Keep this memo",ownership},201);
  const original=await backup();docker("stop",first);
  helper(volumes.original,"const f=require('fs');f.chownSync('/data/setup-token',0,0);f.chmodSync('/data/setup-token',384);f.chmodSync('/data/gameshelf.db',384);f.writeFileSync('/data/unrelated.txt','do not touch',{mode:384});f.mkdirSync('/data/nested');f.writeFileSync('/data/nested/unrelated.txt','nested untouched',{mode:384})");
  const before=inspect(volumes.original);assert.equal(before['setup-token'].uid,0);assert.equal(before['gameshelf.db'].uid,1000);
  clone(volumes.original,volumes.bad);clone(volumes.original,volumes.modified);
  const baseline=failure(volumes.bad,old);assert.equal(baseline.status,1);assert.match(baseline.stderr,/cat: \/data\/setup-token: Permission denied/);
  log(`BASELINE: input=token uid=0 mode=600,db uid=1000 mode=600,PUID=99 PGID=100; literal=${baseline.stderr.trim()}; container-exit=1`);
  const fixed=`${id}-fixed`;await start(fixed,volumes.modified,image);
  assert.deepEqual(await backup(),original);assert.equal((await call("games?rating=5")).total,1);
  const uid=docker("exec",fixed,"node","-e","console.log(require('fs').readFileSync('/proc/1/status','utf8').match(/Uid:\\s+(\\d+)/)[1])");assert.equal(uid,"99");
  const after=inspect(volumes.modified);
  for(const name of ['setup-token','gameshelf.db']){assert.equal(after[name].uid,99);assert.equal(after[name].gid,100);assert.equal(after[name].mode,384);}
  assert.equal(after['setup-token'].hash,before['setup-token'].hash);
  for(const name of ['unrelated.txt','nested/unrelated.txt'])assert.deepEqual(after[name],before[name]);
  log("MODIFIED: health=ok; token owner=99:100 mode=600 content=unchanged; database rows/session=unchanged; process uid=99; unrelated/nested files=unchanged; exit=0");
  browser=await chromium.launch({channel:"chrome",headless:true});const context=await browser.newContext({viewport:{width:1365,height:900}});
  const split=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:base}]);
  const page=await context.newPage();await page.goto(base);await page.getByText("LOCAL-FIRST / v0.1.4",{exact:true}).waitFor();await page.getByRole('heading',{name:'Existing collection',exact:true}).waitFor();
  await page.screenshot({path:resolve(dir,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(dir,'mobile.png'),fullPage:true});await browser.close();browser=null;
  await call("games","POST",{title:"New record after repair",rating:4,ownership},201);const updated=await backup();
  docker("stop",fixed);docker("rm",fixed);containers.splice(containers.indexOf(fixed),1);await start(fixed,volumes.modified,image);assert.deepEqual(await backup(),updated);docker("stop",fixed);
  log("RECREATE: removed/recreated container; original/new records and session preserved; exit=0");
  clone(volumes.modified,volumes.rollback);
  const rollbackScript=resolve(dir,"ROLLBACK.sh");
  writeFileSync(rollbackScript,`#!/usr/bin/env bash\nset -euo pipefail\nexport MSYS_NO_PATHCONV=1\ndocker run --rm --env PUID=99 --env PGID=100 --mount "type=volume,source=\${1:?snapshot volume},target=/data" jyh9521/gameshelf:0.1.3 node -e "console.log('ROLLBACK_STARTUP_OK')"\n`);chmodSync(rollbackScript,0o755);
  const rollback=execFileSync("C:/Program Files/Git/bin/bash.exe",[rollbackScript,volumes.rollback],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});assert.match(rollback,/ROLLBACK_STARTUP_OK/);
  const rowCount=helper(volumes.rollback,"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.game.count().then(n=>console.log(n)).finally(()=>p.$disconnect())");assert.equal(rowCount,"2");
  log("ROLLBACK: old 0.1.3 on separate copy of repaired appdata; literal=ROLLBACK_STARTUP_OK; existing/new game rows=2; exit=0");
  const originalAgain=failure(volumes.bad,old);assert.equal(originalAgain.status,1);assert.match(originalAgain.stderr,/Permission denied/);log("ORIGINAL SNAPSHOT: still reproduces exact Permission denied; container-exit=1; original fixture not modified by repair");
  const fresh=docker("run","--rm","-e","PUID=1000","-e","PGID=1000","-v",`${volumes.fresh}:/data`,image,"node","-e","console.log('FRESH_STARTUP_OK uid='+process.getuid())");assert.match(fresh,/FRESH_STARTUP_OK uid=1000/);log("FRESH: empty volume,UID=1000; literal=FRESH_STARTUP_OK uid=1000; exit=0");
  helper(volumes.symlink,"const f=require('fs');f.writeFileSync('/data/unrelated.txt','unchanged',{mode:384});f.symlinkSync('/data/unrelated.txt','/data/setup-token')");
  const linkBefore=helper(volumes.symlink,"const s=require('fs').statSync('/data/unrelated.txt');console.log(s.uid+':'+s.gid+':'+s.mode)");
  const link=failure(volumes.symlink,image);assert.equal(link.status,1);assert.match(link.stderr,/must not be a symbolic link/);
  assert.equal(helper(volumes.symlink,"const s=require('fs').statSync('/data/unrelated.txt');console.log(s.uid+':'+s.gid+':'+s.mode)"),linkBefore);log("SYMLINK: rejected without modifying target; container-exit=1 (expected)");
  writeFileSync(resolve(dir,"fixture-hashes.json"),JSON.stringify({before,after,volumes,tokenContentUnchanged:true},null,2));
  log("PASS startup ownership regression,existing data/session,rating UI,recreate,rollback,fresh,symlink");
}finally{
  await browser?.close();for(const name of containers){try{writeFileSync(resolve(dir,`${name}.log`),docker('logs',name));docker('stop',name);docker('rm',name);}catch{}}
  for(const v of Object.values(volumes)){try{docker('volume','rm',v);}catch{}}
  writeFileSync(resolve(dir,"regression.txt"),records.join('\n')+'\n');
}
