import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const baseline=process.argv.includes("baseline");
const base=baseline?"http://127.0.0.1:3101":"http://127.0.0.1:3102";
const container=baseline?"gameshelf-auth-baseline":"gameshelf-auth-qa";
const original=execFileSync("docker",["exec",container,"cat","/data/setup-token"],{encoding:"utf8"}).trim();
async function post(path,data,status){const r=await fetch(`${base}/api/${path}`,{method:"POST",headers:{"content-type":"application/json","x-gameshelf-request":"1"},body:JSON.stringify(data)});const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;}
const browser=await chromium.launch({channel:"chrome",headless:true});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(base,{waitUntil:"networkidle"});
  if(baseline){
    assert.equal(await page.locator('[name="password"]').getAttribute("minlength"),"12");
    assert.equal(await page.locator('[name="passwordConfirm"]').count(),0);
    assert.equal(await page.getByRole("button",{name:"随机生成"}).count(),0);
    await post("auth/setup",{username:"qa",password:"a",setupToken:original},400);
    console.log("BASELINE PASS: minLength=12; confirm=absent; generate=absent; short-password=400");
  }else{
    assert.equal(await page.locator('[name="password"]').getAttribute("minlength"),null);
    assert.equal(await page.getByRole("button",{name:"随机生成"}).count(),0);
    await post("auth/setup",{username:"qa",password:"a",passwordConfirm:"b",setupToken:original},400);
    await post("auth/setup",{username:"qa",password:"a",setupToken:original},400);
    await post("auth/setup",{username:"qa",password:"",passwordConfirm:"",setupToken:original},400);
    await page.locator('[name="username"]').fill("qa");
    await page.locator('[name="password"]').fill("a");
    await page.locator('[name="passwordConfirm"]').fill("b");
    await expect(page.getByRole("button",{name:"创建管理员"})).toBeDisabled();
    await expect(page.locator("p[role=alert]")).toHaveText("两次密码输入不一致");
    await page.locator('[name="setupToken"]').fill(original);
    const token=original;
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:"engineering/core-update/setup-mobile.png",fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:"engineering/core-update/setup-desktop.png",fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    execFileSync("docker",["restart",container]);
    for(let i=0;i<60;i++){try{if((await fetch(`${base}/api/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
    assert.equal(execFileSync("docker",["exec",container,"cat","/data/setup-token"],{encoding:"utf8"}).trim(),token);
    await page.reload({waitUntil:"networkidle"});
    await page.locator('[name="username"]').fill("qa");await page.locator('[name="password"]').fill("a");await page.locator('[name="passwordConfirm"]').fill("a");await page.locator('[name="setupToken"]').fill(token);
    await page.getByRole("button",{name:"创建管理员"}).click();
    await expect(page.getByRole("heading",{name:/每一款游戏/})).toBeVisible();
    await post("auth/setup-token",{currentToken:token},401);
    await post("auth/login",{username:"qa",password:"a"},200);
    console.log("PASS AUTH_SETUP: short-password=a; mismatch/missing/empty=400; random=absent; persisted-token=valid; setup=201; login=200; mobile=no-overflow");
  }
}finally{await browser.close();}

