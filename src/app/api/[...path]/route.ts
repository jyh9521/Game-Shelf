import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, ready } from "@/lib/db";
import { currentUser, newSession, cookie, hashPassword, verifyPassword, secureCompare, hashToken, sessionToken } from "@/lib/auth";
import { createInput, gameInput, ownershipInput, releaseInput, defaultPlatforms, defaultStores, normalize } from "@/lib/domain";
import { addOwnership, editContent, ownsGame, saveGame } from "@/lib/library";
import { buildLibraryQuery, buildLibraryFilterOptions } from "@/lib/library-query";
import { backupSchema, validateReferences, exportBackup, restoreBackup } from "@/lib/backup";
import { randomUUID } from "node:crypto";
import { getSetupToken, withBootstrapLock } from "@/lib/bootstrap";
export const runtime="nodejs";
export const dynamic="force-dynamic";
class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
const result=(data:unknown,status=200,headers:Record<string,string>={})=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store",...headers}});
async function body(req:Request){
  const reader=req.body?.getReader();if(!reader) throw new HttpError(400,"请求体为空");
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>10*1024*1024){await reader.cancel();throw new HttpError(413,"请求超过 10 MiB");}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new HttpError(400,"JSON 格式错误");}
}
const credentials=z.object({username:z.string().trim().min(1).max(64),password:z.string().min(1).max(128)}).strict();
async function handle(req:NextRequest,context:{params:Promise<{path:string[]}>}){
  try {
    await ready();
    const path=(await context.params).path;
    const key=path.join("/");const method=req.method;
    if(method!=="GET"){
      if(req.headers.get("x-gameshelf-request")!=="1") throw new HttpError(403,"请求校验失败");
      const origin=req.headers.get("origin");
      const expected=process.env.APP_URL?new URL(process.env.APP_URL).origin:`${new URL(req.url).protocol}//${req.headers.get("host")}`;
      if(origin && origin!==expected) throw new HttpError(403,"请求来源不匹配");
    }
    if(key==="health" && method==="GET"){await db.$queryRaw`SELECT 1`;return result({status:"ok"});}
    if(key==="auth/status" && method==="GET"){
      const u=await currentUser(req);return result({initialized:!!await db.user.count(),user:u?{username:u.username}:null});
    }
    if(key==="auth/setup" && method==="POST")return await withBootstrapLock(async()=>{
      if(await db.user.count()) throw new HttpError(409,"已经初始化");
      const data=credentials.extend({setupToken:z.string().max(256),passwordConfirm:z.string().min(1).max(128)}).refine(d=>d.password===d.passwordConfirm,{path:["passwordConfirm"],message:"两次密码输入不一致"}).parse(await body(req));
      const token=await getSetupToken();
      if(!token || token.length<24 || !secureCompare(data.setupToken,token)) throw new HttpError(403,"初始化凭据不正确");
      const passwordHash=await hashPassword(data.password);
      const user=await db.$transaction(async tx=>{
        const u=await tx.user.create({data:{id:"admin",username:data.username,passwordHash}});
        await tx.platform.createMany({data:defaultPlatforms.map(([id,name])=>({id,name}))});
        await tx.store.createMany({data:defaultStores.map(([id,name])=>({id,name}))});return u;
      });
      return result({username:user.username},201,{"Set-Cookie":cookie(await newSession(user.id))});
    });
    if(key==="auth/login" && method==="POST"){
      const data=credentials.parse(await body(req));
      const key="login";const now=new Date();
      // 在验证密码前原子预留次数，避免并发请求绕过限流。
      const attempts=await db.$transaction(async tx=>{
        const old=await tx.loginAttempt.findUnique({where:{key}});
        if(old && now.getTime()-old.windowStart.getTime()<900000){
          if(old.failures>=10)throw new HttpError(429,"尝试过多，请 15 分钟后再试");
          return tx.loginAttempt.update({where:{key},data:{failures:{increment:1}}});
        }
        return tx.loginAttempt.upsert({where:{key},create:{key,failures:1,windowStart:now},update:{failures:1,windowStart:now}});
      });
      void attempts;
      const user=await db.user.findUnique({where:{username:data.username}});
      if(!user || !await verifyPassword(data.password,user.passwordHash)) throw new HttpError(401,"用户名或密码错误");
      await db.loginAttempt.deleteMany({where:{key}});
      return result({username:user.username},200,{"Set-Cookie":cookie(await newSession(user.id))});
    }
    const user=await currentUser(req);if(!user)throw new HttpError(401,"请先登录");
    if(key==="auth/logout" && method==="POST"){
      const token=sessionToken(req);if(token)await db.session.deleteMany({where:{tokenHash:hashToken(token)}});
      return result({ok:true},200,{"Set-Cookie":cookie("",true)});
    }
    if(key==="catalog" && method==="GET")return result({platforms:await db.platform.findMany(),stores:await db.store.findMany()});
    if(key==="platforms" && method==="POST"){
      const input=z.object({name:z.string().trim().min(1).max(120)}).strict().parse(await body(req));
      return result(await db.platform.create({data:{id:randomUUID(),name:input.name}}),201);
    }
    if(key==="games" && method==="GET"){
      const {where,orderBy,page}=buildLibraryQuery(req.nextUrl.searchParams,user.id);
      const total=await db.game.count({where});
      const items=await db.game.findMany({where,orderBy,skip:(page-1)*24,take:24,
        include:{profiles:{where:{userId:user.id}},releases:{include:{platform:true,contents:{where:{item:{userId:user.id}},include:{item:{include:{store:true}},edition:true}}}}}});
      // 候选来自当前用户的完整库，而不是当前页或当前筛选结果。
      const genres=await db.game.groupBy({by:["genre"],where:{profiles:{some:{userId:user.id}}}});
      const dates=await db.release.groupBy({by:["releaseDate"],where:{game:{profiles:{some:{userId:user.id}}},contents:{some:{item:{userId:user.id}}}}});
      return result({items,total,page:Math.floor(page),pages:Math.max(1,Math.ceil(total/24)),filters:buildLibraryFilterOptions(genres,dates)});
    }
    if(key==="games" && method==="POST"){
      const input=createInput.parse(await body(req));const {ownership,...fields}=input;
      // 作品与拥有记录在同一事务创建，失败不留下孤立作品。
      const id=randomUUID();const {status,rating,favorite,memo,...metadata}=fields;
      const game=await db.$transaction(async tx=>{
        const g=await tx.game.create({data:{id,...metadata,searchText:normalize([metadata.title,metadata.originalTitle,metadata.localizedTitle,metadata.developer,metadata.publisher].join(" "))}});
        await tx.userGameProfile.create({data:{id:randomUUID(),userId:user.id,gameId:id,status,rating,favorite,memo,
          overridesJson:JSON.stringify(Object.fromEntries(Object.entries(metadata).map(([k,v])=>[k,{mode:"MANUAL_OVERRIDE",value:v}])))} });
        await addOwnership(tx,user.id,id,ownership);return g;
      });return result(game,201);
    }
    if(path[0]==="games" && path[1]){
      const id=path[1];if(!await ownsGame(user.id,id))throw new HttpError(404,"游戏不存在");
      if(path.length===2 && method==="GET")return result(await db.game.findUnique({where:{id},include:{profiles:{where:{userId:user.id}},releases:{include:{platform:true,editions:true,contents:{where:{item:{userId:user.id}},include:{item:{include:{store:true}},edition:true}}}}}}));
      if(path.length===2 && method==="PUT")return result(await saveGame(user.id,gameInput.parse(await body(req)),id));
      if(path.length===2 && method==="DELETE"){
        await db.$transaction(async tx=>{
          const contents=await tx.libraryItemContent.findMany({where:{release:{gameId:id},item:{userId:user.id}}});
          await tx.libraryItemContent.deleteMany({where:{id:{in:contents.map(c=>c.id)}}});
          await tx.libraryItem.deleteMany({where:{userId:user.id,contents:{none:{}}}});
          await tx.userGameProfile.delete({where:{userId_gameId:{userId:user.id,gameId:id}}});
          if(!await tx.userGameProfile.count({where:{gameId:id}}))await tx.game.delete({where:{id}});
        });return result({ok:true});
      }
      if(path.length===3 && path[2]==="items" && method==="POST"){
        const input=ownershipInput.parse(await body(req));return result(await db.$transaction(tx=>addOwnership(tx,user.id,id,input)),201);
      }
    }
    if(path[0]==="contents" && path.length===2 && method==="PUT"){
      const input=releaseInput.parse(await body(req));
      const content=await db.$transaction(tx=>editContent(tx,user.id,path[1],input));
      if(!content)throw new HttpError(404,"内容记录不存在");return result(content);
    }
    if(path[0]==="items" && path.length===2 && method==="DELETE"){
      const item=await db.libraryItem.findFirst({where:{id:path[1],userId:user.id}});if(!item)throw new HttpError(404,"条目不存在");
      await db.libraryItem.delete({where:{id:item.id}});return result({ok:true});
    }
    if(path[0]==="items" && path.length===2 && method==="PUT"){
      const item=await db.libraryItem.findFirst({where:{id:path[1],userId:user.id}});if(!item)throw new HttpError(404,"条目不存在");
      const input=ownershipInput.omit({platformId:true,releaseDate:true,region:true,edition:true}).parse(await body(req));
      if(input.storeId&&!await db.store.findUnique({where:{id:input.storeId}}))throw new HttpError(400,"商店不存在");
      return result(await db.libraryItem.update({where:{id:item.id},data:input}));
    }
    if(key==="backup" && method==="GET")return result(await exportBackup(user.id),200,{"Content-Disposition":`attachment; filename="gameshelf-${new Date().toISOString().slice(0,10)}.json"`});
    if(key==="backup/preview" && method==="POST"){
      const b=backupSchema.parse(await body(req));validateReferences(b);
      return result({games:b.games.length,items:b.items.length,empty:await db.game.count()===0});
    }
    if(key==="backup/restore" && method==="POST")return result(await restoreBackup(backupSchema.parse(await body(req)),user.id));
    throw new HttpError(404,"接口不存在");
  }catch(error){
    if(error instanceof HttpError)return result({error:error.message},error.status);
    if(error instanceof z.ZodError)return result({error:"数据校验失败",details:error.issues.map(i=>`${i.path.join(".")}: ${i.message}`)},400);
    if(error instanceof Error && /平台不存在|商店不存在|恢复要求空库|悬空引用|重复|Edition 不属于|缺少/.test(error.message))return result({error:error.message},400);
    console.error("API failure",error instanceof Error?error.name:"unknown");return result({error:"操作失败，请检查输入或服务器状态"},500);
  }
}
export {handle as GET,handle as POST,handle as PUT,handle as DELETE};
