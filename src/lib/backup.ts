import { z } from "zod";
import { db } from "./db";
import { gameInput, ownershipInput, date, statuses, normalize } from "./domain";
import { hashToken } from "./auth";
const id = z.string().min(1).max(100);
const timestamp = z.iso.datetime();
const nullableSeconds = z.number().int().min(0).max(2147483647).nullable();
export const backupSchema = z.object({
  format: z.literal("gameshelf"), schema_version: z.literal(1), exportedAt: timestamp,
  platforms: z.array(z.object({ id, name: z.string().min(1).max(120) }).strict()).max(1000),
  stores: z.array(z.object({ id, name: z.string().min(1).max(120) }).strict()).max(1000),
  games: z.array(gameInput.pick({title:true,originalTitle:true,localizedTitle:true,description:true,developer:true,publisher:true,genre:true,coverUrl:true}).extend({id,createdAt:timestamp,updatedAt:timestamp}).strict()).max(100000),
  releases: z.array(z.object({id,gameId:id,platformId:id,region:z.string().max(80),releaseDate:date}).strict()).max(300000),
  editions: z.array(z.object({id,releaseId:id,name:z.string().min(1).max(120)}).strict()).max(300000),
  items: z.array(ownershipInput.omit({platformId:true,releaseDate:true,region:true,edition:true}).extend({id,sourceTotalSeconds:nullableSeconds,createdAt:timestamp}).strict()).max(300000),
  contents: z.array(z.object({id,libraryItemId:id,releaseId:id,editionId:id.nullable()}).strict()).max(300000),
  profiles: z.array(z.object({id,gameId:id,status:z.enum(statuses),rating:z.number().int().min(1).max(5).nullable(),favorite:z.boolean(),memo:z.string().max(20000),overridesJson:z.string().max(100000).refine(s=>{
    try { const o=JSON.parse(s); return o && !Array.isArray(o) && typeof o === "object" && Object.values(o).every(v=> v && typeof v==="object" && (v as {mode?:string}).mode==="MANUAL_OVERRIDE"); } catch { return false; }
  })}).strict()).max(100000)
}).strict();
export type Backup = z.infer<typeof backupSchema>;
export function validateReferences(b: Backup) {
  const sets = new Map<string, Set<string>>();
  for (const name of ["platforms","stores","games","releases","editions","items","contents","profiles"] as const) {
    const ids = b[name].map(v=>v.id);
    if (new Set(ids).size!==ids.length) throw new Error(`${name} 存在重复 ID`);
    sets.set(name,new Set(ids));
  }
  const ref=(name:string,key:string)=>{ if(!sets.get(name)?.has(key)) throw new Error(`悬空引用：${name}`); };
  for(const list of [b.platforms,b.stores]) if(new Set(list.map(v=>v.name)).size!==list.length) throw new Error("名称重复");
  const releaseKeys=new Set<string>();
  for(const r of b.releases){ref("games",r.gameId);ref("platforms",r.platformId);const k=JSON.stringify([r.gameId,r.platformId,r.region,r.releaseDate]);if(releaseKeys.has(k))throw new Error("发行身份重复");releaseKeys.add(k);}
  const editionKeys=new Set<string>();
  for(const e of b.editions){ref("releases",e.releaseId);const k=JSON.stringify([e.releaseId,e.name]);if(editionKeys.has(k))throw new Error("Edition 身份重复");editionKeys.add(k);}
  for(const i of b.items) if(i.storeId) ref("stores",i.storeId);
  const editionMap=new Map(b.editions.map(e=>[e.id,e.releaseId]));
  const releaseMap=new Map(b.releases.map(r=>[r.id,r.gameId]));
  const keys=new Set<string>();
  for(const c of b.contents){
    ref("items",c.libraryItemId);ref("releases",c.releaseId);
    if(c.editionId){ref("editions",c.editionId);if(editionMap.get(c.editionId)!==c.releaseId) throw new Error("Edition 不属于发行版本");}
    const k=JSON.stringify([c.libraryItemId,c.releaseId]);if(keys.has(k)) throw new Error("内容关系重复");keys.add(k);
  }
  const profiles=new Set<string>();
  for(const p of b.profiles){ref("games",p.gameId);if(profiles.has(p.gameId)) throw new Error("作品档案重复");profiles.add(p.gameId);}
  const populatedItems=new Set(b.contents.map(c=>c.libraryItemId));
  for(const i of b.items) if(!populatedItems.has(i.id)) throw new Error("库条目缺少内容");
  for(const c of b.contents) if(!profiles.has(releaseMap.get(c.releaseId)!)) throw new Error("库内容缺少个人档案");
}
export async function exportBackup(userId: string): Promise<Backup> {
  // 同一事务取得一致性快照，不包含管理员密码、会话或认证配置。
  return db.$transaction(async tx=>{
    const profiles=await tx.userGameProfile.findMany({where:{userId}});
    const gameIds=profiles.map(p=>p.gameId);
    const games=await tx.game.findMany({where:{id:{in:gameIds}}});
    const releases=await tx.release.findMany({where:{gameId:{in:gameIds}}});
    const editions=await tx.edition.findMany({where:{releaseId:{in:releases.map(r=>r.id)}}});
    const items=await tx.libraryItem.findMany({where:{userId}});
    const contents=await tx.libraryItemContent.findMany({where:{libraryItemId:{in:items.map(i=>i.id)}}});
    return backupSchema.parse({format:"gameshelf",schema_version:1,exportedAt:new Date().toISOString(),
      platforms:await tx.platform.findMany(),stores:await tx.store.findMany(),
      games:games.map(({searchText,...g})=>({...g,createdAt:g.createdAt.toISOString(),updatedAt:g.updatedAt.toISOString()})),
      releases,editions,items:items.map(({userId,...i})=>({...i,createdAt:i.createdAt.toISOString()})),
      contents,profiles:profiles.map(({userId,...p})=>p)});
  });
}
export async function restoreBackup(b: Backup,userId:string) {
  validateReferences(b);
  // 忽略文件中对象键与实体排列顺序，让同一份内容可幂等重试。
  const canonical = (value: unknown): unknown => {
    if(Array.isArray(value)) return [...value].sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(canonical);
    if(value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
    return value;
  };
  const importId=hashToken(userId+JSON.stringify(canonical({...b,exportedAt:""})));
  return db.$transaction(async tx=>{
    if(await tx.backupImport.findUnique({where:{id:importId}})) return {duplicate:true,games:0,items:0};
    if(await tx.game.count() || await tx.libraryItem.count()) throw new Error("恢复要求空库，请先导出当前数据或使用新实例");
    await tx.platform.deleteMany();await tx.store.deleteMany();
    await tx.platform.createMany({data:b.platforms});await tx.store.createMany({data:b.stores});
    await tx.game.createMany({data:b.games.map(g=>({...g,searchText:normalize([g.title,g.originalTitle,g.localizedTitle,g.developer,g.publisher].join(" "))}))});
    await tx.release.createMany({data:b.releases});await tx.edition.createMany({data:b.editions});
    await tx.libraryItem.createMany({data:b.items.map(i=>({...i,userId}))});
    await tx.libraryItemContent.createMany({data:b.contents});
    await tx.userGameProfile.createMany({data:b.profiles.map(p=>({...p,userId}))});
    await tx.backupImport.create({data:{id:importId,userId}});
    return {duplicate:false,games:b.games.length,items:b.items.length};
  },{timeout:30000});
}
