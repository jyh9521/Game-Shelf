// Each run owns a fresh SQLite database, temporary port, credentials and server.
// No existing instance, .env credential, personal library or Docker volume is used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const baseline=process.argv.includes("--baseline");
const dir=resolve("engineering",`weekly-smoke-${baseline?"baseline":"modified"}-${Date.now()}`);
mkdirSync(dir,{recursive:true});
const token=randomBytes(24).toString("hex"),password=randomBytes(18).toString("hex");
const tokenFile=resolve(dir,"setup-token");writeFileSync(tokenFile,token);
writeFileSync(resolve(dir,"qa.db"),"");
const env={...process.env,DATABASE_URL:`file:${resolve(dir,"qa.db").replaceAll("\\","/")}`,SETUP_TOKEN_FILE:tokenFile,SETUP_TOKEN:token,APP_URL:"",SECURE_COOKIE:"false"};
execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env,stdio:"pipe"});
const db=new PrismaClient({datasourceUrl:env.DATABASE_URL});
const reservation=createServer();await new Promise(r=>reservation.listen(0,"127.0.0.1",r));
const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{env,stdio:["ignore","pipe","pipe"],windowsHide:true});
let serverLog="",browser,cookie="",checks=0;
child.stdout.on("data",d=>serverLog+=d);child.stderr.on("data",d=>serverLog+=d);
const exited=new Promise(resolve=>child.once("exit",resolve));
async function call(path,method="GET",data,status=200){
  const response=await fetch(`${base}/api/${path}`,{method,signal:AbortSignal.timeout(10000),headers:{cookie,"content-type":"application/json","x-gameshelf-request":"1"},body:data===undefined?undefined:JSON.stringify(data)});
  const body=await response.json();
  assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(body)}`);checks++;
  if(response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie").split(";")[0];
  return body;
}
const ownership={platformId:"PC",storeId:"STEAM",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE"};
const physical={...ownership,platformId:"PS4",storeId:"PHYSICAL",mediaType:"PHYSICAL"};
const games=[];
async function add(title,fields={},owned={}){
  const game=await call("games","POST",{title,...fields,ownership:{...ownership,...owned}},201);
  games.push(game);return game;
}
async function matches(params,ids){
  const data=await call(`games?${new URLSearchParams(params)}`);
  assert.deepEqual(data.items.map(g=>g.id).sort(),ids.slice().sort());assert.equal(data.total,ids.length);
  return data;
}
const canonical=backup=>Object.fromEntries(Object.entries(backup).filter(([k])=>k!=="exportedAt").map(([k,v])=>[k,Array.isArray(v)?v.slice().sort((a,b)=>a.id.localeCompare(b.id)):v]));

try{
  let ready=false;for(let i=0;i<100;i++){
    try{if((await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,200));
  }
  assert.ok(ready,"isolated QA server must become healthy");
  await call("games?year=2005","GET",undefined,401);
  await call("auth/setup","POST",{username:"weekly-qa",password,passwordConfirm:password,setupToken:token},201);
  const a=await add("QA 星海远航",{originalTitle:"ＳＴＡＲ Voyage",genre:"RPG",rating:5,status:"CLEARED",favorite:true},{releaseDate:"2005"});
  await call(`games/${a.id}/items`,"POST",{...physical,releaseDate:"2010-03",acquisitionType:"BORROWED",accessStatus:"RETURNED"},201);
  const b=await add("QA 森林手帖",{originalTitle:"森の手帖",genre:"RPG",rating:4},{...physical,platformId:"NS1",releaseDate:"2005-11"});
  const c=await add("QA 雨夜追踪",{originalTitle:"Rain Watch",genre:"动作 / 冒险",rating:5,status:"PLAYING"},{releaseDate:"2020-02-29"});
  const d=await add("QA 空白档案");
  const e=await add("QA 同名类型",{genre:"unknown"},{releaseDate:"2005-12-01"});
  const f=await add("QA 待补日期",{genre:"RPG"},physical);
  if(baseline){
    for(const params of [{genre:"RPG"},{year:"2005"},{unclassified:"true"},{year:"unknown"}]){
      assert.equal((await call(`games?${new URLSearchParams(params)}`)).total,6);
    }
    assert.equal((await call("games?platform=PS4&year=2005")).total,2);
    console.log(`BASELINE PASS HTTP=${checks}; genre=ignored; year=ignored; cross-version=2; personal-db=untouched`);
  }else{
    const original=await call("backup");
    await matches({genre:"RPG"},[a.id,b.id,f.id]);
    await matches({genre:"unknown"},[e.id]);
    await matches({genre:"动作 / 冒险"},[c.id]);
    await matches({unclassified:"true"},[d.id]);
    await matches({year:"2005"},[a.id,b.id,e.id]);
    await matches({year:"unknown"},[d.id,f.id]);
    await matches({year:"2005",platform:"PS4"},[]);
    await matches({year:"2010",store:"STEAM"},[]);
    await matches({year:"2010",mediaType:"DIGITAL"},[]);
    await matches({year:"2010",acquisitionType:"PURCHASE"},[]);
    await matches({year:"2010",accessStatus:"ACTIVE"},[]);
    await matches({year:"2010",platform:"PS4",store:"PHYSICAL",mediaType:"PHYSICAL",acquisitionType:"BORROWED",accessStatus:"RETURNED"},[a.id]);
    await matches({genre:"RPG",year:"2005",platform:"PC",rating:"5",status:"CLEARED",favorite:"true"},[a.id]);
    await matches({genre:"RPG",q:"star voyage"},[a.id]);
    await matches({genre:"RPG",q:"森の手帖"},[b.id]);
    await matches({year:"2020",q:"雨夜"},[c.id]);
    await matches({genre:"RPG",year:"2020"},[]);
    for(const year of ["0000","2005-01","20%_","20050","UNKNOWN"," 2005 "]){
      await call(`games?${new URLSearchParams({year})}`,"GET",undefined,400);
    }
    await call("games?genre=RPG&unclassified=true","GET",undefined,400);
    await call(`games?${new URLSearchParams({genre:"x".repeat(501)})}`,"GET",undefined,400);
    assert.deepEqual(canonical(await call("backup")),canonical(original),"filter reads never change library data");
    const options=(await call("games?q=no-such-game&page=2")).filters;
    assert.deepEqual(options,{genres:["动作 / 冒险","RPG","unknown"],years:["2020","2010","2005"]});

    // Old release rows remain after re-linking/deleting a copy; they are not owned years.
    const orphan=await call(`games/${a.id}/items`,"POST",{...ownership,releaseDate:"1999"},201);
    await call(`items/${orphan.id}`,"DELETE");
    await matches({year:"1999"},[]);
    assert.ok(!(await call("games")).filters.years.includes("1999"));
    const detail=await call(`games/${f.id}`),content=detail.releases[0].contents[0];
    await call(`contents/${content.id}`,"PUT",{platformId:"PS4",releaseDate:"2021"});
    await matches({year:"unknown"},[d.id]);await matches({year:"2021"},[f.id]);
    await call(`contents/${content.id}`,"PUT",{platformId:"PS4",releaseDate:""});
    assert.ok(!(await call("games")).filters.years.includes("2021"));

    const filler=[];
    for(let i=0;i<25;i++)filler.push(await add(`QA 分页 ${String(i).padStart(2,"0")}`,{genre:"分页 QA"},{releaseDate:"2018"}));
    const first=await call("games?genre=%E5%88%86%E9%A1%B5+QA&sort=title_asc&page=1");
    const second=await call("games?genre=%E5%88%86%E9%A1%B5+QA&sort=title_asc&page=2");
    assert.equal(first.total,25);assert.equal(first.items.length,24);assert.equal(second.items.length,1);
    assert.equal(new Set([...first.items,...second.items].map(g=>g.id)).size,25);

    const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==="win32"&&existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")?"msedge":undefined);
    browser=await chromium.launch({channel,headless:true});
    const page=await browser.newPage({viewport:{width:1365,height:1000}});
    const external=[];await page.route("**/*",route=>{
      if(new URL(route.request().url()).origin===base)return route.continue();
      external.push(route.request().url());return route.abort();
    });
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(base);await page.locator('[name="username"]').fill("weekly-qa");await page.locator('[name="password"]').fill(password);
    await page.getByRole("button",{name:"登录游戏库",exact:true}).click();
    await expect(page.locator(".count")).toHaveText("31");
    const genres=page.getByRole("group",{name:"筛选游戏类型"}),years=page.getByRole("group",{name:"筛选拥有版本发售年份"});
    await page.getByRole("button",{name:"下一页",exact:true}).click();await expect(page.locator(".pagination")).toContainText("2 / 2");
    await genres.getByRole("button",{name:"类型：RPG",exact:true}).click();
    await expect(page.locator(".count")).toHaveText("3");await expect(page.locator(".pagination")).toContainText("1 / 1");
    await years.getByRole("button",{name:"2005",exact:true}).click();await expect(page.locator(".count")).toHaveText("2");
    await page.getByRole("group",{name:"筛选个人评分"}).getByRole("button",{name:"5 星",exact:true}).click();
    await expect(page.locator(".count")).toHaveText("1");await expect(page.getByRole("heading",{name:a.title,exact:true})).toBeVisible();
    await expect(years.getByRole("button",{name:"2005",exact:true})).toHaveAttribute("aria-pressed","true");
    await page.screenshot({path:resolve(dir,"desktop.png"),fullPage:true});
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();await expect(page.locator(".count")).toHaveText("31");
    await expect(genres.getByRole("button",{name:"全部类型",exact:true})).toHaveAttribute("aria-pressed","true");
    await expect(years.getByRole("button",{name:"全部年份",exact:true})).toHaveAttribute("aria-pressed","true");
    await page.setViewportSize({width:390,height:844});
    await genres.getByRole("button",{name:"未分类",exact:true}).click();await years.getByRole("button",{name:"年份未知",exact:true}).click();
    await expect(page.locator(".count")).toHaveText("1");await expect(page.getByRole("heading",{name:d.title,exact:true})).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"mobile overflow");
    await page.screenshot({path:resolve(dir,"mobile.png"),fullPage:true});
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();await expect(page.locator(".count")).toHaveText("31");
    await page.setViewportSize({width:1365,height:1000});
    await genres.getByRole("button",{name:"类型：unknown",exact:true}).click();await expect(page.locator(".count")).toHaveText("1");
    await page.getByRole("heading",{name:e.title,exact:true}).click();await page.getByRole("button",{name:"编辑资料",exact:true}).click();
    await page.locator('[name="genre"]').fill("策略");await page.getByRole("button",{name:"保存游戏",exact:true}).click();
    await expect(page.locator(".count")).toHaveText("0");await expect(page.getByRole("heading",{name:"没有符合条件的游戏",exact:true})).toBeVisible();
    await expect(genres.getByRole("button",{name:"类型：unknown",exact:true})).toHaveAttribute("aria-pressed","true");
    await genres.getByRole("button",{name:"类型：策略",exact:true}).click();await expect(page.locator(".count")).toHaveText("1");
    // Year alone must produce the filtered-empty state, not the first-game invitation.
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();await expect(page.locator(".count")).toHaveText("31");
    await years.getByRole("button",{name:"2020",exact:true}).click();await expect(page.locator(".count")).toHaveText("1");
    await page.getByRole("heading",{name:c.title,exact:true}).click();await page.getByRole("button",{name:"修改版本",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"修改发行版本",exact:true});
    await dialog.locator('[name="releaseDate"]').fill("2022");await dialog.getByRole("button",{name:"保存版本",exact:true}).click();
    await page.getByRole("dialog",{name:"游戏详情",exact:true}).getByRole("button",{name:"关闭",exact:true}).click();
    await expect(page.locator(".count")).toHaveText("0");await expect(page.getByRole("heading",{name:"没有符合条件的游戏",exact:true})).toBeVisible();
    await expect(years.getByRole("button",{name:"2020",exact:true})).toHaveAttribute("aria-pressed","true");
    await years.getByRole("button",{name:"2022",exact:true}).click();await expect(page.locator(".count")).toHaveText("1");
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await browser.close();browser=undefined;

    for(const game of filler)await call(`games/${game.id}`,"DELETE");
    assert.ok(!(await call("games")).filters.genres.includes("分页 QA"));
    const backup=await call("backup");assert.equal(backup.schema_version,1);
    assert.ok(!/passwordHash|tokenHash|setupToken/.test(JSON.stringify(backup)));
    writeFileSync(resolve(dir,"demo-backup.json"),JSON.stringify(backup,null,2));
    for(const game of backup.games)await call(`games/${game.id}`,"DELETE");
    assert.equal((await call("games")).total,0);
    await call("backup/restore","POST",{...backup,schema_version:99},400);
    assert.equal((await call("games")).total,0);
    assert.equal((await call("backup/preview","POST",backup)).empty,true);
    assert.equal((await call("backup/restore","POST",backup)).games,6);
    assert.equal((await call("backup/restore","POST",backup)).duplicate,true);
    assert.deepEqual(canonical(await call("backup")),canonical(backup));
    await matches({genre:"RPG",year:"2005"},[a.id,b.id]);
    await matches({year:"2022"},[c.id]);await matches({genre:"策略"},[e.id]);
    assert.ok(!(await call("games")).filters.years.includes("1999"));

    // Separate account plus shared Game metadata: neither other-user genres nor owned years leak into facets/results.
    const adminSession=cookie,admin=await db.user.findUniqueOrThrow({where:{username:"weekly-qa"}});
    await db.user.create({data:{id:"qa-other",username:"qa-other",passwordHash:admin.passwordHash}});
    await db.userGameProfile.create({data:{id:randomUUID(),userId:"qa-other",gameId:a.id}});
    await call("auth/login","POST",{username:"qa-other",password});
    await call("games","POST",{title:"Hidden QA",genre:"PRIVATE",ownership:{...ownership,releaseDate:"1899"}},201);
    await call(`games/${a.id}/items`,"POST",{...ownership,releaseDate:"1901"},201);
    const other=(await call("games")).filters;
    assert.deepEqual(other,{genres:["PRIVATE","RPG"],years:["1901","1899"]});
    await matches({year:"2005"},[]);
    cookie=adminSession;
    const own=(await call("games")).filters;
    assert.ok(!own.genres.includes("PRIVATE"));assert.ok(!own.years.includes("1899"));assert.ok(!own.years.includes("1901"));
    await matches({year:"1901"},[]);await matches({genre:"PRIVATE"},[]);
    cookie="";await call("games?genre=RPG&year=2005","GET",undefined,401);
    console.log(`MODIFIED PASS HTTP=${checks}; UI=desktop,mobile,pagination-reset,combined,empty,edit-refresh; backup=v1-roundtrip; isolation=pass; external-requests=0; personal-db=untouched`);
  }
  console.log(`QA_ARTIFACTS=${dir}`);
}finally{
  await browser?.close();await db.$disconnect();
  if(child.exitCode===null)child.kill();await exited;
  writeFileSync(resolve(dir,"server.log"),serverLog.replaceAll(token,"[QA_TOKEN]"));
}
