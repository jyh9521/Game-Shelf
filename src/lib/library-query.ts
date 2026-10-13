import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { statuses, mediaTypes, acquisitions, accessStatuses, normalize } from "./domain";

export const librarySorts=["added_desc","added_asc","title_asc","title_desc","updated_desc"] as const;
export const librarySortLabels:Record<typeof librarySorts[number],string>={added_desc:"添加时间：最新优先",added_asc:"添加时间：最早优先",title_asc:"标题：升序",title_desc:"标题：降序",updated_desc:"资料更新时间：最新优先"};
const optionalEnum=<T extends readonly [string,...string[]]>(values:T)=>z.preprocess(v=>v===""?undefined:v,z.enum(values).optional());
const query=z.object({
  q:z.string().default(""),platform:z.string().max(80).optional(),store:z.string().max(80).optional(),
  status:optionalEnum(statuses),mediaType:optionalEnum(mediaTypes),acquisitionType:optionalEnum(acquisitions),accessStatus:optionalEnum(accessStatuses),
  favorite:z.enum(["true","false"]).default("false"),sort:z.enum(librarySorts).default("added_desc"),
  page:z.coerce.number().int().min(1).max(100000).catch(1)
});
export function buildLibraryQuery(params:URLSearchParams,userId:string){
  const data=query.parse(Object.fromEntries(params));const search=normalize(data.q).slice(0,500);
  const item:Prisma.LibraryItemWhereInput={userId,...(data.store?{storeId:data.store}:{}),...(data.mediaType?{mediaType:data.mediaType}:{}),...(data.acquisitionType?{acquisitionType:data.acquisitionType}:{}),...(data.accessStatus?{accessStatus:data.accessStatus}:{})};
  const where:Prisma.GameWhereInput={profiles:{some:{userId,...(data.status?{status:data.status}:{}),...(data.favorite==="true"?{favorite:true}:{})}},...(search?{searchText:{contains:search}}:{}),
    ...((data.platform||data.store||data.mediaType||data.acquisitionType||data.accessStatus)?{releases:{some:{...(data.platform?{platformId:data.platform}:{}),contents:{some:{item}}}}}:{})};
  const orders:Record<typeof librarySorts[number],Prisma.GameOrderByWithRelationInput>={added_desc:{createdAt:"desc"},added_asc:{createdAt:"asc"},title_asc:{title:"asc"},title_desc:{title:"desc"},updated_desc:{updatedAt:"desc"}};
  // 所有排序均以稳定 ID 收尾；组合拥有筛选必须命中同一个条目。
  return {where,orderBy:[orders[data.sort],{id:"asc"}] as Prisma.GameOrderByWithRelationInput[],page:data.page};
}
