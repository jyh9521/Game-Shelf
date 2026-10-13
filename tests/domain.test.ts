import test from "node:test";
import assert from "node:assert/strict";
import { normalize, gameInput, date, effectiveSeconds } from "../src/lib/domain";
import { hashPassword, verifyPassword } from "../src/lib/auth";
import { backupSchema, validateReferences } from "../src/lib/backup";
test("中文、日文、全角英文检索规范化",()=>{
  assert.equal(normalize("  ＳＴＥＡＭ  Game  "),"steam game");
  assert.equal(normalize("西风狂诗曲"),"西风狂诗曲");assert.equal(normalize("ゼルダ"),"ゼルダ");
});
test("时长覆盖不是叠加，未知不变成零",()=>{
  assert.equal(effectiveSeconds({sourceTotalSeconds:85*3600,manualTotalOverride:100*3600,manualExtraSeconds:0}),100*3600);
  assert.equal(effectiveSeconds({sourceTotalSeconds:null,manualTotalOverride:null,manualExtraSeconds:3600}),null);
  assert.equal(effectiveSeconds({sourceTotalSeconds:0,manualTotalOverride:null,manualExtraSeconds:0}),0);
});
test("评分、标题及日期校验",()=>{
  assert.equal(gameInput.safeParse({title:""}).success,false);
  assert.equal(gameInput.safeParse({title:"Test",rating:0}).success,false);
  for(const v of ["2024","2024-02","2024-02-29",""])assert.equal(date.safeParse(v).success,true,v);
  for(const v of ["2023-02-29","2024-13","2024-04-31","tomorrow"])assert.equal(date.safeParse(v).success,false,v);
});
test("密码散列带随机盐并验证错误密码",async()=>{
  const a=await hashPassword("long test password"),b=await hashPassword("long test password");
  assert.notEqual(a,b);assert.equal(await verifyPassword("long test password",a),true);assert.equal(await verifyPassword("wrong password",a),false);
});
test("版本化备份拒绝未知字段、未知版本和悬空引用",()=>{
  const base={format:"gameshelf",schema_version:1,exportedAt:new Date().toISOString(),platforms:[],stores:[],games:[],releases:[],editions:[],items:[],contents:[],profiles:[]};
  assert.equal(backupSchema.safeParse(base).success,true);
  assert.equal(backupSchema.safeParse({...base,schema_version:2}).success,false);
  assert.equal(backupSchema.safeParse({...base,passwordHash:"secret"}).success,false);
  const b=backupSchema.parse({...base,releases:[{id:"r",gameId:"missing",platformId:"PC",releaseDate:"",region:""}]});
  assert.throws(()=>validateReferences(b),/悬空引用/);
});
