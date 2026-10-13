import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
const url=process.env.TEST_DATABASE_URL;
assert.match(url??"",/qa3\.db$/, "只允许 qa3 隔离测试库");
const db=new PrismaClient({datasourceUrl:url});
try {
  const game=await db.game.findFirst();const item=await db.libraryItem.findFirst();assert(game&&item);
  const uid="access-test";
  await db.user.upsert({where:{id:uid},create:{id:uid,username:uid,passwordHash:"not-a-login"},update:{}});
  const token=randomBytes(32).toString("hex");
  await db.session.create({data:{tokenHash:createHash("sha256").update(token).digest("hex"),userId:uid,expiresAt:new Date(Date.now()+60000)}});
  for(const [path,method] of [[`games/${game.id}`,"GET"],[`games/${game.id}`,"PUT"],[`games/${game.id}`,"DELETE"],[`items/${item.id}`,"PUT"],[`items/${item.id}`,"DELETE"]]){
    const r=await fetch(`http://127.0.0.1:3100/api/${path}`,{method,headers:{cookie:`gameshelf_session=${token}`,"x-gameshelf-request":"1"}});assert.equal(r.status,404);
  }
  const r=await fetch("http://127.0.0.1:3100/api/games",{headers:{cookie:`gameshelf_session=${token}`}});assert.equal((await r.json()).total,0);
  console.log("PASS ACCESS_CHECK foreign_game=404 foreign_item=404 foreign_library=empty checks=6");
  await db.session.deleteMany({where:{userId:uid}});await db.user.delete({where:{id:uid}});
} finally {await db.$disconnect();}
