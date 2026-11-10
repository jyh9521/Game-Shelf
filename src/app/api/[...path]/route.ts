import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, ready } from "@/lib/db";
import { currentUser, newSession, cookie, hashPassword, verifyPassword, secureCompare, hashToken, sessionToken } from "@/lib/auth";
import { ownershipInput, releaseInput, defaultPlatforms, defaultStores } from "@/lib/domain";
import { addOwnership, editContent, ownsGame } from "@/lib/library";
import { buildLibraryQuery, buildLibraryFilterOptions } from "@/lib/library-query";
import { backupSchema, validateReferences, exportBackup, restoreBackup } from "@/lib/backup";
import { getSetupToken, withBootstrapLock } from "@/lib/bootstrap";
import { relationInput, relationEditInput, RelationError } from "@/lib/relation-domain";
import { listRelations, createRelation, changeRelation } from "@/lib/relations";
import { createGame, effectiveGame, reportFields, unlockField, updateGame } from "@/lib/game-metadata";
import { createGameInput, previewInput, searchInput, unlockInput, updateGameInput } from "@/lib/metadata-domain";
import { metadataService } from "@/lib/metadata-service";
import { MetadataError } from "@/lib/metadata-http";
import { createPlatform, platformInput, PlatformError, removePlatform, updatePlatform } from "@/lib/platform-catalog";
import { previewSteamLibrary, steamPreviewConfigured } from "@/lib/steam-preview";
import { geminiTranslationConfigured, translateDescription } from "@/lib/gemini-translation";
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
    const isAdmin=user.id==="admin";
    if(key==="catalog" && method==="GET")return result({platforms:await db.platform.findMany(),stores:await db.store.findMany(),
      canManagePlatforms:isAdmin,steamPreview:isAdmin?{configured:steamPreviewConfigured()}:null,
      descriptionTranslation:isAdmin?{configured:geminiTranslationConfigured()}:null});
    if(key==="steam/preview" && method==="POST"){
      if(!isAdmin)throw new HttpError(403,"仅实例管理员可以预览 Steam 游戏库");
      return result(await previewSteamLibrary(await body(req)));
    }
    if(key==="translations/description" && method==="POST"){
      if(!isAdmin)throw new HttpError(403,"仅实例管理员可以使用 Gemini 翻译");
      return result(await translateDescription(await body(req)));
    }
    if(key==="metadata/providers" && method==="GET")return result({providers:metadataService().status()});
    if(key==="metadata/search" && method==="POST"){
      const {provider,query}=searchInput.parse(await body(req));
      return result({items:await metadataService().search(user.id,provider,query)});
    }
    if(key==="metadata/preview" && method==="POST"){
      const {provider,id,page}=previewInput.parse(await body(req));
      return result(await metadataService().preview(user.id,provider,id,page));
    }
    if(key==="platforms" && method==="POST"){
      if(!isAdmin)throw new HttpError(403,"仅实例管理员可以管理平台");
      return result(await createPlatform(platformInput.parse(await body(req))),201);
    }
    if(path[0]==="platforms" && path.length===2 && (method==="PUT" || method==="DELETE")){
      if(!isAdmin)throw new HttpError(403,"仅实例管理员可以管理平台");
      return result(method==="PUT" ? await updatePlatform(path[1],platformInput.parse(await body(req))) : await removePlatform(path[1]));
    }
    if(key==="games" && method==="GET"){
      const {where,orderBy,page}=buildLibraryQuery(req.nextUrl.searchParams,user.id);
      const total=await db.userGameProfile.count({where});
      const profiles=await db.userGameProfile.findMany({where,orderBy,skip:(page-1)*24,take:24,
        include:{metadata:true,game:{include:{releases:{include:{platform:true,contents:{where:{item:{userId:user.id}},include:{item:{include:{store:true}},edition:true}}}}}}}});
      const items=profiles.map(p=>effectiveGame(p.game,p));
      // 候选来自当前用户的完整库，而不是当前页或当前筛选结果。
      const genres=await db.userGameMetadata.groupBy({by:["genre"],where:{profile:{userId:user.id}}});
      const dates=await db.release.groupBy({by:["releaseDate"],where:{game:{profiles:{some:{userId:user.id}}},contents:{some:{item:{userId:user.id}}}}});
      return result({items,total,page:Math.floor(page),pages:Math.max(1,Math.ceil(total/24)),filters:buildLibraryFilterOptions(genres,dates)});
    }
    if(key==="games" && method==="POST")return result(await createGame(user.id,createGameInput.parse(await body(req))),201);
    if(path[0]==="games" && path[1]){
      const id=path[1];if(!await ownsGame(user.id,id))throw new HttpError(404,"游戏不存在");
      if(path.length===2 && method==="GET"){
        const p=await db.userGameProfile.findUnique({where:{userId_gameId:{userId:user.id,gameId:id}},
          include:{metadata:true,game:{include:{releases:{include:{platform:true,editions:true,contents:{where:{item:{userId:user.id}},include:{item:{include:{store:true}},edition:true}}}}}}}});
        if(!p)throw new HttpError(404,"游戏不存在");
        return result(effectiveGame(p.game,p));
      }
      if(path.length===2 && method==="PUT")return result(await updateGame(user.id,id,updateGameInput.parse(await body(req))));
      if(path.length===3 && path[2]==="fields" && method==="GET")return result(await reportFields(user.id,id));
      if(path.length===4 && path[2]==="fields" && path[3]==="unlock" && method==="POST")
        return result(await unlockField(user.id,id,unlockInput.parse(await body(req))));
      if(path.length===2 && method==="DELETE"){
        await db.$transaction(async tx=>{
          const contents=await tx.libraryItemContent.findMany({where:{release:{gameId:id},item:{userId:user.id}}});
          await tx.libraryItemContent.deleteMany({where:{id:{in:contents.map(c=>c.id)}}});
          await tx.libraryItem.deleteMany({where:{userId:user.id,contents:{none:{}}}});
          const relationshipWhere={userId:user.id,OR:[{sourceGameId:id},{targetGameId:id}]};
          await tx.gameRelation.deleteMany({where:relationshipWhere});
          await tx.gameRelationEvent.deleteMany({where:relationshipWhere});
          await tx.userGameProfile.delete({where:{userId_gameId:{userId:user.id,gameId:id}}});
          if(!await tx.userGameProfile.count({where:{gameId:id}}))await tx.game.delete({where:{id}});
        });return result({ok:true});
      }
      if(path.length===3 && path[2]==="items" && method==="POST"){
        const input=ownershipInput.parse(await body(req));return result(await db.$transaction(tx=>addOwnership(tx,user.id,id,input)),201);
      }
      if(path.length===3 && path[2]==="relations"){
        if(method==="GET")return result(await listRelations(user.id,id));
        if(method==="POST")return result(await createRelation(user.id,id,relationInput.parse(await body(req))),201);
      }
    }
    if(path[0]==="relations" && path.length===2){
      if(method==="PUT")return result(await changeRelation(user.id,path[1],relationEditInput.parse(await body(req))));
      if(method==="DELETE")return result(await changeRelation(user.id,path[1],null));
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
      const raw=await body(req),b=backupSchema.parse(raw);validateReferences(b);
      return result({games:b.games.length,items:b.items.length,relations:b.relations.length,relationHistory:b.relationHistory.length,
        fieldHistory:b.fieldHistory.length,schemaVersion:b.schema_version,migratedFrom:raw.schema_version===3?null:raw.schema_version,empty:await db.game.count()===0});
    }
    if(key==="backup/restore" && method==="POST")return result(await restoreBackup(backupSchema.parse(await body(req)),user.id));
    throw new HttpError(404,"接口不存在");
  }catch(error){
    if(error instanceof HttpError)return result({error:error.message},error.status);
    if(error instanceof RelationError || error instanceof PlatformError)return result({error:error.message},error.status);
    if(error instanceof MetadataError)return result({error:error.message},error.status,error.retryAt?
      {"Retry-After":String(Math.max(1,Math.ceil((error.retryAt-Date.now())/1000)))}:{});
    if(error instanceof z.ZodError)return result({error:"数据校验失败",details:error.issues.map(i=>`${i.path.join(".")}: ${i.message}`)},400);
    if(error instanceof Error && /平台不存在|商店不存在|恢复要求空库|悬空引用|重复|Edition 不属于|缺少|字段历史/.test(error.message))return result({error:error.message},400);
    console.error("API failure",error instanceof Error?error.name:"unknown");return result({error:"操作失败，请检查输入或服务器状态"},500);
  }
}
export {handle as GET,handle as POST,handle as PUT,handle as DELETE};
