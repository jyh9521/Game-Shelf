import test from "node:test";
import assert from "node:assert/strict";
import { buildLibraryQuery, librarySorts } from "../src/lib/library-query";
import { releaseInput } from "../src/lib/domain";
test("拥有条件绑定同一个条目，筛选保留用户隔离",()=>{
  const q=buildLibraryQuery(new URLSearchParams("platform=PS4&store=PHYSICAL&mediaType=PHYSICAL&acquisitionType=BORROWED&accessStatus=RETURNED&status=PLAYING&favorite=true"),"owner");
  assert.deepEqual(q.where.releases,{some:{platformId:"PS4",contents:{some:{item:{userId:"owner",storeId:"PHYSICAL",mediaType:"PHYSICAL",acquisitionType:"BORROWED",accessStatus:"RETURNED"}}}}});
  assert.deepEqual(q.where.profiles,{some:{userId:"owner",status:"PLAYING",favorite:true}});
});
test("排序稳定，非法分页回到第一页，非法筛选被拒绝",()=>{
  for(const sort of librarySorts)assert.deepEqual(buildLibraryQuery(new URLSearchParams({sort}),"u").orderBy.at(-1),{id:"asc"});
  for(const page of ["NaN","0","-1","1.5","Infinity","100001"])assert.equal(buildLibraryQuery(new URLSearchParams({page}),"u").page,1);
  for(const query of ["mediaType=FAKE","sort=sql","accessStatus=INVALID"])assert.throws(()=>buildLibraryQuery(new URLSearchParams(query),"u"));
  assert.deepEqual(buildLibraryQuery(new URLSearchParams("q=ＴＥＳＴ+++Game"),"u").where.searchText,{contains:"test game"});
});
test("版本编辑只接受发行字段及有效日期",()=>{
  assert.equal(releaseInput.parse({platformId:"PC",releaseDate:"2000-02-29",edition:"Deluxe"}).region,"");
  assert.throws(()=>releaseInput.parse({platformId:"PC",releaseDate:"2023-02-29"}));
  assert.throws(()=>releaseInput.parse({platformId:"PC",storeId:"STEAM"}));
});
