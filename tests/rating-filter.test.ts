import test from "node:test";
import assert from "node:assert/strict";
import { buildLibraryQuery } from "../src/lib/library-query";

test("评分筛选区分全部、未评分和每个合法星级",()=>{
  for(const query of ["", "rating="]){
    assert.deepEqual(buildLibraryQuery(new URLSearchParams(query),"owner").where.profiles,{some:{userId:"owner"}});
  }
  assert.deepEqual(buildLibraryQuery(new URLSearchParams("rating=unrated"),"owner").where.profiles,{some:{userId:"owner",rating:null}});
  for(let rating=1;rating<=5;rating++){
    assert.deepEqual(buildLibraryQuery(new URLSearchParams({rating:String(rating)}),"owner").where.profiles,{some:{userId:"owner",rating}});
  }
});

test("评分、状态与收藏绑定同一用户档案，不影响拥有筛选与分页",()=>{
  const query=buildLibraryQuery(new URLSearchParams("rating=5&status=CLEARED&favorite=true&platform=PC&mediaType=DIGITAL&page=2&sort=title_asc"),"owner");
  assert.deepEqual(query.where.profiles,{some:{userId:"owner",status:"CLEARED",favorite:true,rating:5}});
  assert.deepEqual(query.where.releases,{some:{platformId:"PC",contents:{some:{item:{userId:"owner",mediaType:"DIGITAL"}}}}});
  assert.equal(query.page,2);
  assert.deepEqual(query.orderBy,[{title:"asc"},{id:"asc"}]);
});

test("评分筛选拒绝范围外、非整数及非约定值",()=>{
  for(const rating of ["0","6","-1","1.5","NaN","null","05"," 5 ","UNRATED"]){
    assert.throws(()=>buildLibraryQuery(new URLSearchParams({rating}),"owner"));
  }
});
