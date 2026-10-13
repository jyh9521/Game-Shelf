import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetupToken, withBootstrapLock } from "../src/lib/bootstrap";
test("初始化验证码读取持久化文件，串行锁在异常后释放",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"gameshelf-bootstrap-"));
  const oldFile=process.env.SETUP_TOKEN_FILE,oldToken=process.env.SETUP_TOKEN;
  process.env.SETUP_TOKEN_FILE=join(dir,"setup-token");process.env.SETUP_TOKEN="original-fixture-credential";
  try{
    assert.equal(await getSetupToken(),process.env.SETUP_TOKEN);
    await writeFile(process.env.SETUP_TOKEN_FILE,"persisted-fixture-credential");
    assert.equal(await getSetupToken(),"persisted-fixture-credential");
    const order:number[]=[];
    await Promise.all([withBootstrapLock(async()=>{order.push(1);await new Promise(r=>setTimeout(r,20));order.push(2);}),withBootstrapLock(async()=>{order.push(3);})]);
    assert.deepEqual(order,[1,2,3]);await assert.rejects(withBootstrapLock(async()=>{throw new Error("fixture");}));
    assert.equal(await withBootstrapLock(async()=>"released"),"released");
  }finally{
    if(oldFile===undefined)delete process.env.SETUP_TOKEN_FILE;else process.env.SETUP_TOKEN_FILE=oldFile;
    if(oldToken===undefined)delete process.env.SETUP_TOKEN;else process.env.SETUP_TOKEN=oldToken;
    await rm(dir,{recursive:true,force:true});
  }
});
