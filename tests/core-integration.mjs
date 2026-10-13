import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
const baseline=process.argv.includes("baseline"),container=baseline?"gameshelf-core-baseline":"gameshelf-core-qa",base=baseline?"http://127.0.0.1:3101":"http://127.0.0.1:3103";
const setupToken=execFileSync("docker",["exec",container,"cat","/data/setup-token"],{encoding:"utf8"}).trim();
let session="",checks=0;
async function call(path,method="GET",data,status=200,cookie=session){const r=await fetch(`${base}/api/${path}`,{method,headers:{cookie,"x-gameshelf-request":"1","content-type":"application/json"},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));if(r.headers.get("set-cookie"))session=r.headers.get("set-cookie").split(";")[0];checks++;return v;}
const ownership={platformId:"PC",storeId:"STEAM",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE",releaseDate:"2005",edition:"Standard",region:"US",manualTotalOverride:3600};
await call("auth/setup","POST",{username:"qa",password:"core-test-password",passwordConfirm:"core-test-password",setupToken},201);
const z=await call("games","POST",{title:"Zebra",ownership},201);
await call(`games/${z.id}/items`,"POST",{...ownership,platformId:"PS4",storeId:"PHYSICAL",mediaType:"PHYSICAL",acquisitionType:"BORROWED",accessStatus:"RETURNED"},201);
await call(`games/${z.id}/items`,"POST",{...ownership,platformId:"PS4",storeId:"PHYSICAL",mediaType:"PHYSICAL",acquisitionType:"BORROWED",accessStatus:"RETURNED"},201);
const a=await call("games","POST",{title:"Alpha",ownership:{...ownership,storeId:"GOG",acquisitionType:"FREE"}},201);
const m=await call("games","POST",{title:"Middle",ownership:{...ownership,platformId:"PS5",mediaType:"PHYSICAL",accessStatus:"EXPIRED"}},201);
let detail=await call(`games/${z.id}`);const ps4=detail.releases.find(r=>r.platformId==="PS4"),target=ps4.contents[0],other=ps4.contents[1];
const edited={platformId:"NS1",releaseDate:"2020-02-29",region:"JP",edition:"Deluxe"};
if(baseline){await call(`contents/${target.id}`,"PUT",edited,404);assert.equal((await call("games?mediaType=PHYSICAL")).total,3);assert.deepEqual((await call("games?sort=title_asc")).items.map(g=>g.title),["Middle","Alpha","Zebra"]);console.log("BASELINE PASS: content-edit=404; media-filter=ignored; title-sort=ignored");process.exit(0);}
await call(`contents/${target.id}`,"PUT",edited,401,"");

await call('contents/missing','PUT',edited,404);
await call(`contents/${target.id}`,'PUT',{...edited,platformId:'MISSING'},400);
await call(`contents/${target.id}`,'PUT',{...edited,releaseDate:'2023-02-29'},400);
await call(`contents/${target.id}`,'PUT',edited);
detail=await call(`games/${z.id}`);
const moved=detail.releases.find(r=>r.contents.some(c=>c.id===target.id));assert.equal(moved.platformId,'NS1');assert.equal(moved.releaseDate,'2020-02-29');assert.equal(moved.region,'JP');assert.equal(moved.contents.find(c=>c.id===target.id).edition.name,'Deluxe');checks+=4;
const unchanged=detail.releases.find(r=>r.contents.some(c=>c.id===other.id));assert.equal(unchanged.id,ps4.id);assert.equal(unchanged.contents.find(c=>c.id===other.id).edition.name,'Standard');assert.equal(unchanged.releaseDate,'2005');checks+=3;
assert.equal((await call('games?mediaType=PHYSICAL')).total,2);
assert.equal((await call('games?store=STEAM&mediaType=PHYSICAL')).total,1); // Middle has a physical Steam record
assert.equal((await call('games?store=GOG&mediaType=PHYSICAL')).total,0);
assert.equal((await call('games?acquisitionType=BORROWED&accessStatus=ACTIVE')).total,0);
assert.equal((await call('games?platform=PS4&mediaType=PHYSICAL&acquisitionType=BORROWED&accessStatus=RETURNED')).total,1);
assert.equal((await call('games?acquisitionType=FREE')).items[0].id,a.id);checks+=6;
assert.deepEqual((await call('games?sort=title_asc')).items.map(g=>g.title),['Alpha','Middle','Zebra']);assert.deepEqual((await call('games?sort=title_desc')).items.map(g=>g.title),['Zebra','Middle','Alpha']);checks+=2;
await call('games?mediaType=invalid','GET',undefined,400);await call('games?sort=invalid','GET',undefined,400);assert.equal((await call('games?page=NaN')).page,1);checks++;
const ties=[];for(let i=0;i<25;i++)ties.push(await call('games','POST',{title:'Tie',ownership},201));
const first=await call('games?sort=title_asc&page=1'),second=await call('games?sort=title_asc&page=2');const combined=[...first.items,...second.items];assert.equal(first.pages,2);assert.equal(new Set(combined.map(g=>g.id)).size,28);assert.deepEqual(combined.filter(g=>g.title==='Tie').map(g=>g.id),ties.map(g=>g.id).sort());checks+=3;
for(const g of ties)await call(`games/${g.id}`,'DELETE');
function fixture(code){execFileSync('docker',['exec',container,'node','-e',`const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{${code}})().finally(()=>p.$disconnect());`],{encoding:'utf8'});}
fixture(`const u=await p.user.findUnique({where:{id:'admin'}});await p.user.create({data:{id:'qa-other',username:'qa-other',passwordHash:u.passwordHash}});`);
const adminSession=session;await call('auth/login','POST',{username:'qa-other',password:'core-test-password'});
await call(`contents/${target.id}`,'PUT',edited,404);assert.equal((await call('games')).total,0);checks++;session=adminSession;
const pc=detail.releases.find(r=>r.platformId==='PC');
fixture(`await p.libraryItemContent.create({data:{id:'qa-extra-content',libraryItemId:${JSON.stringify(target.libraryItemId)},releaseId:${JSON.stringify(pc.id)}}});`);
const before=await call('backup');await call(`contents/${target.id}`,'PUT',{platformId:'PC',releaseDate:'2005',region:'US',edition:'Blocked Edition'},400);
const after=await call('backup');for(const key of ['contents','releases','editions'])assert.deepEqual(after[key].sort((a,b)=>a.id.localeCompare(b.id)),before[key].sort((a,b)=>a.id.localeCompare(b.id)));checks+=3;
fixture(`await p.libraryItemContent.delete({where:{id:'qa-extra-content'}});`);
const backup=await call('backup');writeFileSync('engineering/core-update/core-backup.json',JSON.stringify(backup,null,2));
for(const game of [z,a,m])await call(`games/${game.id}`,'DELETE');
await call('backup/restore','POST',backup);const restored=await call('backup');for(const key of ['games','releases','editions','items','contents','profiles'])assert.deepEqual(restored[key].sort((a,b)=>a.id.localeCompare(b.id)),backup[key].sort((a,b)=>a.id.localeCompare(b.id)));checks+=6;
assert.equal((await call('backup/restore','POST',backup)).duplicate,true);checks++;
console.log(`MODIFIED PASS: checks=${checks}; content-edit=isolated; filters=same-item; sort=stable-pagination; foreign-content=404; duplicate=transaction-rollback; backup=roundtrip`);
