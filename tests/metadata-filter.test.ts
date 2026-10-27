import test from "node:test";
import assert from "node:assert/strict";
import { buildLibraryQuery, buildLibraryFilterOptions } from "../src/lib/library-query";

test("类型是完整的现有值，未分类与名为 unknown 的类型互不冲突",()=>{
  for(const genre of ["RPG","动作 / 冒险","unknown","  RPG  ","未分类"]){
    assert.equal(buildLibraryQuery(new URLSearchParams({genre}),"owner").where.genre,genre);
  }
  assert.equal(buildLibraryQuery(new URLSearchParams("unclassified=true"),"owner").where.genre,"");
  for(const value of ["","genre=&year=&unclassified=false"]){
    const query=buildLibraryQuery(new URLSearchParams(value),"owner");
    assert.equal(query.where.genre,undefined);assert.equal(query.where.releases,undefined);
  }
  assert.throws(()=>buildLibraryQuery(new URLSearchParams("genre=RPG&unclassified=true"),"owner"));
  assert.throws(()=>buildLibraryQuery(new URLSearchParams({genre:"a".repeat(501)}),"owner"));
  assert.throws(()=>buildLibraryQuery(new URLSearchParams("unclassified=1"),"owner"));
});

test("年份与平台及拥有条件绑定同一发行和条目，不跨版本凑条件",()=>{
  const q=buildLibraryQuery(new URLSearchParams("genre=RPG&year=2005&platform=PC&store=STEAM&mediaType=DIGITAL&acquisitionType=PURCHASE&accessStatus=ACTIVE&rating=5&status=CLEARED&favorite=true&page=2&sort=title_asc"),"owner");
  assert.equal(q.where.genre,"RPG");
  assert.deepEqual(q.where.releases,{some:{platformId:"PC",releaseDate:{startsWith:"2005"},contents:{some:{item:{userId:"owner",storeId:"STEAM",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE"}}}}});
  assert.deepEqual(q.where.profiles,{some:{userId:"owner",status:"CLEARED",favorite:true,rating:5}});
  assert.equal(q.page,2);assert.deepEqual(q.orderBy,[{title:"asc"},{id:"asc"}]);
});

test("未知年份只匹配本人拥有的未知日期，合法四位年份保留精度",()=>{
  assert.deepEqual(buildLibraryQuery(new URLSearchParams("year=unknown"),"owner").where.releases,{some:{releaseDate:"",contents:{some:{item:{userId:"owner"}}}}});
  for(const year of ["0001","1900","2000","2005","9999"]){
    assert.deepEqual(buildLibraryQuery(new URLSearchParams({year}),"u").where.releases,{some:{releaseDate:{startsWith:year},contents:{some:{item:{userId:"u"}}}}});
  }
  for(const year of ["0","0000","5","200","20050","2005-01"," 2005 ","２００５","UNKNOWN","NaN","20%_"]){
    assert.throws(()=>buildLibraryQuery(new URLSearchParams({year}),"u"),year);
  }
});

test("筛选候选去重：保留完整类型，年份从日期精度提取并倒序",()=>{
  assert.deepEqual(buildLibraryFilterOptions([{genre:"RPG"},{genre:"RPG"},{genre:""},{genre:"动作 / 冒险"}],
    ["2005","2005-02","2005-02-28","2020-02-29","","0001","0000","bad"].map(releaseDate=>({releaseDate}))),
    {genres:["动作 / 冒险","RPG"],years:["2020","2005","0001"]});
  assert.deepEqual(buildLibraryFilterOptions([],[]),{genres:[],years:[]});
});
