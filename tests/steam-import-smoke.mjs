import assert from "node:assert/strict";
import {execFileSync,spawn} from "node:child_process";
import {randomBytes,createHash} from "node:crypto";
import {mkdirSync,writeFileSync,existsSync} from "node:fs";
import {resolve} from "node:path";
import {createServer} from "node:net";
import {PrismaClient} from "@prisma/client";
import {chromium,expect} from "@playwright/test";
import {key} from "./steam-preview-fixture.cjs";
import {checkSteamImport,connect,assertion,stable} from "./steam-import-checks.mjs";
const root=resolve(process.env.IMPORT_QA_DIR??"engineering/steam-import-"+Date.now());mkdirSync(root,{recursive:true});
const file=n=>resolve(root,n),token=randomBytes(24).toString("hex"),password=randomBytes(24).toString("hex");
const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const base="http://127.0.0.1:"+port;
writeFileSync(file("qa.db"),"");writeFileSync(file("setup-token"),token);writeFileSync(file("upstream.log"),"");
const env={...process.env,DATABASE_URL:"file:"+file("qa.db").replaceAll("\\","/"),SETUP_TOKEN:token,SETUP_TOKEN_FILE:file("setup-token"),
  APP_URL:base,SECURE_COOKIE:"false",STEAM_WEB_API_KEY:key,GAMESHELF_QA_STEAM_LOG:file("upstream.log"),NEXT_TELEMETRY_DISABLED:"1"};
writeFileSync(file("migration.log"),execFileSync(process.execPath,[resolve("node_modules/prisma/build/index.js"),"migrate","deploy"],{env,encoding:"utf8",windowsHide:true}));
const db=new PrismaClient({datasourceUrl:env.DATABASE_URL});
const child=spawn(process.execPath,["--require",resolve("tests/steam-import-fixture.cjs"),resolve("node_modules/next/dist/bin/next"),"start","--hostname","127.0.0.1","--port",String(port)],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
let log="",cookie="",checks=0,browser;child.stdout.on("data",v=>log+=v);child.stderr.on("data",v=>log+=v);
const exited=new Promise(r=>child.once("exit",r));
async function api(path,method="GET",input,status=200,session=cookie,requestHeader=true){
  const r=await fetch(base+"/api/"+path,{method,headers:{cookie:session,"content-type":"application/json",...(requestHeader?{"x-gameshelf-request":"1"}:{})},body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(35000)});
  const data=await r.json();assert.equal(r.status,status,path+": "+JSON.stringify(data));checks++;
  assert.equal(r.headers.get("cache-control"),"no-store");
  if(r.headers.get("set-cookie"))cookie=r.headers.get("set-cookie").split(";")[0];return data;
}
try{
  for(let i=0;i<100;i++){try{if((await fetch(base+"/api/health")).ok)break;}catch{}if(i===99||child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,150));}
  await api("auth/setup","POST",{username:"qa",password,passwordConfirm:password,setupToken:token},201);
  if(process.argv.includes("--baseline")){
    await api("steam/account","GET",undefined,404);console.log("BASELINE steam-account=404 import=absent");
  }else{
    await api("steam/account","GET",undefined,401,"");
    await api("steam/account/start","POST",{},403,cookie,false);
    const member=randomBytes(32).toString("hex");
    await db.user.create({data:{id:"other",username:"other",passwordHash:"unused"}});
    await db.session.create({data:{tokenHash:createHash("sha256").update(member).digest("hex"),userId:"other",expiresAt:new Date(Date.now()+3600000)}});
    for(const [path,method] of [["steam/account","GET"],["steam/account/start","POST"],["steam/account/complete","POST"],["steam/import/preview","POST"],["steam/import","POST"]])
      await api(path,method,method==="GET"?undefined:{},403,"gameshelf_session="+member);
    const pending=assertion((await api("steam/account/start","POST",{})).url);
    await db.steamAuthAttempt.updateMany({data:{expiresAt:new Date(0)}});
    await api("steam/account/complete","POST",{query:pending.query},400);
    const bad=assertion((await api("steam/account/start","POST",{})).url);
    await api("steam/account/complete","POST",{query:bad.query.replace("qa-valid","invalid")},400);
    const result=await checkSteamImport(api);
    const expired=await api("steam/import/preview","POST",{});
    await db.steamImportPreview.updateMany({data:{expiresAt:new Date(0)}});
    await api("steam/import","POST",{token:expired.token,confirmed:true,choices:[{appid:90004,gameId:null}]},409);
    assert.deepEqual(stable(await api("backup")),result.backup);
    // A pending assertion is bound to the exact login session, not just user ID.
    const oldSession=cookie, bound=assertion((await api("steam/account/start","POST",{})).url);
    await api("auth/login","POST",{username:"qa",password});
    await api("steam/account/complete","POST",{query:bound.query},400);
    await api("steam/account/complete","POST",{query:bound.query},200,oldSession);
    // Concurrent resubmission either serializes or returns a retryable conflict; no duplicate ownership.
    const concurrent=await api("steam/import/preview","POST",{});
    const input={token:concurrent.token,confirmed:true,choices:[{appid:90004,gameId:null}]};
    const concurrentResults=await Promise.all([api("steam/import","POST",input),api("steam/import","POST",input)]);
    assert.equal(concurrentResults.reduce((n,r)=>n+r.created,0),1);assert.equal(concurrentResults.reduce((n,r)=>n+r.duplicate,0),1);
    browser=await chromium.launch({headless:true,channel:process.platform==="win32"&&existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")?"msedge":undefined});
    const page=await browser.newPage({viewport:{width:1365,height:920}}),errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.context().addCookies([{name:"gameshelf_session",value:cookie.split("=")[1],url:base}]);
    const homonym=await api("games","POST",{title:"QA manual import target",ownership:{platformId:"NS1"}},201);
    const callback=assertion((await api("steam/account/start","POST",{})).url);
    await page.goto(base+"/steam/callback?"+callback.query);
    await page.getByRole("button",{name:"完成验证",exact:true}).click();await expect(page.getByRole("status")).toContainText("已验证 Steam 账号");
    await page.getByRole("link",{name:"返回游戏库"}).click();await page.getByRole("button",{name:"Steam 预览",exact:true}).click();
    const panel=page.getByRole("region",{name:"Steam 确认导入"});
    await panel.getByRole("button",{name:"预览已验证账号的导入清单"}).click();
    await expect(panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true})).toBeVisible();
    await expect(panel.getByRole("button",{name:"确认导入所选项目（0）"})).toBeDisabled();
    await panel.getByLabel("查找其他已有作品").fill("QA manual import target");
    await panel.getByRole("button",{name:"查找本人作品"}).click();
    await expect(panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true}).locator(`option[value="${result.target}"]`)).toHaveCount(1);
    await expect(panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true}).locator(`option[value="${result.target}"]`)).toContainText(result.target);
    await expect(panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true}).locator(`option[value="${homonym.id}"]`)).toContainText(homonym.id);
    await panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true}).selectOption(result.target);
    await panel.getByLabel("查找其他已有作品").fill("no-result-distinct-search");
    await panel.getByRole("button",{name:"查找本人作品"}).click();
    await expect(panel.getByRole("button",{name:"查找本人作品"})).toBeEnabled();
    await expect(panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true})).toHaveValue(result.target);
    await panel.getByRole("combobox",{name:"导入方式 · 90005",exact:true}).selectOption("new");
    await panel.screenshot({path:file("import-desktop.png")});
    await page.setViewportSize({width:390,height:844});
    writeFileSync(file("mobile-layout.json"),JSON.stringify(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right,text:e.textContent.slice(0,60)}))})),null,2));
    await panel.screenshot({path:file("import-mobile-layout.png")});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await panel.getByRole("button",{name:"下一页",exact:true}).click();
    await expect(panel.getByRole("combobox",{name:"导入方式 · 90013",exact:true})).toBeVisible();
    await panel.getByRole("combobox",{name:"导入方式 · 90013",exact:true}).selectOption("new");
    await panel.screenshot({path:file("import-mobile.png")});
    page.once("dialog",d=>d.dismiss());await panel.getByRole("button",{name:"确认导入所选项目（2）"}).click();
    assert.equal((await api("backup")).steamLinks.length,4);
    page.once("dialog",d=>d.accept());await panel.getByRole("button",{name:"确认导入所选项目（2）"}).click();
    await expect(panel.getByRole("status")).toContainText("新增 2 份");assert.equal((await api("backup")).steamLinks.length,6);
    assert.deepEqual(errors,[]);await browser.close();browser=null;
    const saved=await api("backup");
    const malformed=structuredClone(saved);malformed.steamLinks[0].libraryItemId="missing";
    await api("backup/preview","POST",malformed,400);
    const duplicate=structuredClone(saved);duplicate.steamLinks.push({...duplicate.steamLinks[0],id:"duplicate"});
    await api("backup/preview","POST",duplicate,400);
    // Reset only the isolated QA DB to exercise portable empty-library restore.
    await db.steamAccount.deleteMany();await db.libraryItem.deleteMany();await db.game.deleteMany();await db.backupImport.deleteMany();
    assert.equal((await api("backup/preview","POST",saved)).steamLinks,6);
    await api("backup/restore","POST",saved);assert.deepEqual(stable(await api("backup")),stable(saved));
    assert.equal((await api("steam/account")).account,null);await api("steam/import/preview","POST",{},409);
    assert.equal((await api("backup/restore","POST",saved)).duplicate,true);
    await connect(api);const restored=await api("steam/import/preview","POST",{});assert.equal(restored.links.length,6);
    assert.equal((await api("steam/import","POST",{token:restored.token,confirmed:true,choices:[{appid:90001,gameId:result.target}]})).duplicate,1);
    console.log("IMPORT PASS identity=session-bound replay=blocked import=atomic duplicate=stable concurrent=one personal=preserved backup=v4-roundtrip reverify=required desktop=1365 mobile=390");
  }
  console.log("HTTP_CHECKS="+checks+" QA_ARTIFACTS="+root);
}finally{await browser?.close();if(child.exitCode===null)child.kill();await exited;await db.$disconnect();writeFileSync(file("server.log"),log.replaceAll(token,"[QA]").replaceAll(password,"[QA]"));}
