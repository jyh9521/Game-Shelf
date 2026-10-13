import { PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";
const db=new PrismaClient();
async function main(){
  assert.match(process.env.DATABASE_URL??"",/benchmark\.db/,"只允许独立 benchmark.db");
  assert.equal(await db.game.count(),0,"性能样本库须为空");
  await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await db.user.create({data:{id:"benchmark",username:"benchmark",passwordHash:"not-a-login"}});
  await db.platform.create({data:{id:"PC",name:"PC"}});
  const start=performance.now();
  for(let from=0;from<10000;from+=500){
    const ns=Array.from({length:500},(_,i)=>from+i);
    await db.$transaction(async tx=>{
      await tx.game.createMany({data:ns.map(i=>({id:`g${i}`,title:`测试游戏 ${i}`,searchText:`测试游戏 ${i} test game ${i}`,developer:"测试开发商"}))});
      await tx.release.createMany({data:ns.map(i=>({id:`r${i}`,gameId:`g${i}`,platformId:"PC"}))});
      await tx.libraryItem.createMany({data:ns.map(i=>({id:`i${i}`,userId:"benchmark",mediaType:"DIGITAL",acquisitionType:"PURCHASE",accessStatus:"ACTIVE"}))});
      await tx.libraryItemContent.createMany({data:ns.map(i=>({id:`c${i}`,libraryItemId:`i${i}`,releaseId:`r${i}`}))});
      await tx.userGameProfile.createMany({data:ns.map(i=>({id:`p${i}`,userId:"benchmark",gameId:`g${i}`}))});
    });
  }
  const inserted=performance.now()-start;
  const t=performance.now();
  const count=await db.game.count({where:{searchText:{contains:"测试游戏 99"}}});
  const query=performance.now()-t;
  const t2=performance.now();
  const page=await db.game.findMany({take:24,orderBy:[{createdAt:"desc"},{id:"asc"}],include:{profiles:true,releases:{include:{platform:true,contents:{include:{item:true}}}}}});
  const list=performance.now()-t2;
  assert.equal(await db.game.count(),10000);assert.equal(await db.libraryItem.count(),10000);assert.equal(page.length,24);assert.equal(count,111);
  console.log(`PASS BENCHMARK games=10000 items=10000 insert_ms=${inserted.toFixed(1)} search_ms=${query.toFixed(1)} page24_ms=${list.toFixed(1)} host=Windows24 sample=synthetic`);
}
main().finally(()=>db.$disconnect());
