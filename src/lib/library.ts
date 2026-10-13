import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { gameInput, ownershipInput, releaseInput, normalize } from "./domain";
import type { z } from "zod";
export async function ownsGame(userId:string,gameId:string) {
  return !!await db.userGameProfile.findUnique({where:{userId_gameId:{userId,gameId}}});
}
async function resolveRelease(tx:Prisma.TransactionClient,gameId:string,input:z.infer<typeof releaseInput>){
  if(!await tx.platform.findUnique({where:{id:input.platformId}})) throw new Error("平台不存在");
  const release=await tx.release.upsert({where:{gameId_platformId_region_releaseDate:{gameId,platformId:input.platformId,region:input.region,releaseDate:input.releaseDate}},
    create:{id:randomUUID(),gameId,platformId:input.platformId,region:input.region,releaseDate:input.releaseDate},update:{}});
  const edition=input.edition ? await tx.edition.upsert({where:{releaseId_name:{releaseId:release.id,name:input.edition}},create:{id:randomUUID(),releaseId:release.id,name:input.edition},update:{}}):null;
  return {release,edition};
}
export async function editContent(tx:Prisma.TransactionClient,userId:string,contentId:string,input:z.infer<typeof releaseInput>){
  const content=await tx.libraryItemContent.findFirst({where:{id:contentId,item:{userId}},include:{release:true}});
  if(!content)return null;
  if(!await tx.userGameProfile.findUnique({where:{userId_gameId:{userId,gameId:content.release.gameId}}}))return null;
  const {release,edition}=await resolveRelease(tx,content.release.gameId,input);
  if(await tx.libraryItemContent.findFirst({where:{libraryItemId:content.libraryItemId,releaseId:release.id,id:{not:content.id}}}))throw new Error("内容关系重复：该拥有记录已包含目标发行版本");
  // 只重关联这一份内容，不直接改写被其他实体拷贝共享的发行资料。
  return tx.libraryItemContent.update({where:{id:content.id},data:{releaseId:release.id,editionId:edition?.id??null}});
}
export async function addOwnership(tx:Prisma.TransactionClient,userId:string,gameId:string,input:z.infer<typeof ownershipInput>) {
  if(input.storeId && !await tx.store.findUnique({where:{id:input.storeId}})) throw new Error("商店不存在");
  const {release,edition}=await resolveRelease(tx,gameId,input);
  return tx.libraryItem.create({data:{id:randomUUID(),userId,storeId:input.storeId,mediaType:input.mediaType,acquisitionType:input.acquisitionType,accessStatus:input.accessStatus,manualTotalOverride:input.manualTotalOverride,manualExtraSeconds:input.manualExtraSeconds,
    contents:{create:{id:randomUUID(),releaseId:release.id,editionId:edition?.id}}}});
}
export async function saveGame(userId:string,input:z.infer<typeof gameInput>,gameId?:string) {
  const {status,rating,favorite,memo,...metadata}=input;
  const searchText=normalize([metadata.title,metadata.originalTitle,metadata.localizedTitle,metadata.developer,metadata.publisher].join(" "));
  const overridesJson=JSON.stringify(Object.fromEntries(Object.entries(metadata).map(([key,value])=>[key,{mode:"MANUAL_OVERRIDE",value}])));
  return db.$transaction(async tx=>{
    const id=gameId??randomUUID();
    const game=gameId ? await tx.game.update({where:{id},data:{...metadata,searchText}}) : await tx.game.create({data:{id,...metadata,searchText}});
    await tx.userGameProfile.upsert({where:{userId_gameId:{userId,gameId:id}},create:{id:randomUUID(),userId,gameId:id,status,rating,favorite,memo,overridesJson},update:{status,rating,favorite,memo,overridesJson}});
    return game;
  });
}
