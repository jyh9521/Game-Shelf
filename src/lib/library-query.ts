import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { statuses, mediaTypes, acquisitions, accessStatuses, normalize } from "./domain";

export const librarySorts=["added_desc","added_asc","title_asc","title_desc","updated_desc"] as const;
export const librarySortLabels:Record<typeof librarySorts[number],string>={added_desc:"添加时间：最新优先",added_asc:"添加时间：最早优先",title_asc:"标题：升序",title_desc:"标题：降序",updated_desc:"资料更新时间：最新优先"};
export const libraryRatings=["unrated","1","2","3","4","5"] as const;
const optionalEnum=<T extends readonly [string,...string[]]>(values:T)=>z.preprocess(v=>v===""?undefined:v,z.enum(values).optional());
const optionalYear=z.preprocess(v=>v===""?undefined:v,z.string().regex(/^(unknown|\d{4})$/).refine(v=>v!=="0000").optional());
const query=z.object({
  q:z.string().default(""),platform:z.string().max(80).optional(),store:z.string().max(80).optional(),
  status:optionalEnum(statuses),mediaType:optionalEnum(mediaTypes),acquisitionType:optionalEnum(acquisitions),accessStatus:optionalEnum(accessStatuses),
  favorite:z.enum(["true","false"]).default("false"),sort:z.enum(librarySorts).default("added_desc"),
  rating:optionalEnum(libraryRatings),
  genre:z.preprocess(v=>v===""?undefined:v,z.string().max(500).optional()),
  unclassified:z.enum(["true","false"]).default("false"),year:optionalYear,
  page:z.coerce.number().int().min(1).max(100000).catch(1)
}).refine(v=>!(v.genre && v.unclassified==="true"),{path:["genre"],message:"类型和未分类条件不能同时指定"});

export type LibraryFilterOptions={genres:string[];years:string[]};
export function buildLibraryFilterOptions(genres:{genre:string}[],dates:{releaseDate:string}[]):LibraryFilterOptions{
  return {
    // 类型仍是完整的自由文本值；不拆分或改写已有分类。
    genres:[...new Set(genres.map(g=>g.genre).filter(g=>g!==""))].sort((a,b)=>a.localeCompare(b,"zh-CN")),
    years:[...new Set(dates.map(r=>r.releaseDate.slice(0,4)).filter(y=>/^\d{4}$/.test(y)&&y!=="0000"))].sort().reverse()
  };
}
export function buildLibraryQuery(params:URLSearchParams,userId:string){
  const data=query.parse(Object.fromEntries(params));const search=normalize(data.q).slice(0,500);
  const item:Prisma.LibraryItemWhereInput={userId,...(data.store?{storeId:data.store}:{}),...(data.mediaType?{mediaType:data.mediaType}:{}),...(data.acquisitionType?{acquisitionType:data.acquisitionType}:{}),...(data.accessStatus?{accessStatus:data.accessStatus}:{})};
  const where:Prisma.GameWhereInput={profiles:{some:{userId,...(data.status?{status:data.status}:{}),...(data.favorite==="true"?{favorite:true}:{}),...(data.rating?{rating:data.rating==="unrated"?null:Number(data.rating)}:{})}},...(search?{searchText:{contains:search}}:{}),
    ...(data.unclassified==="true"?{genre:""}:data.genre?{genre:data.genre}:{}),
    ...((data.platform||data.store||data.mediaType||data.acquisitionType||data.accessStatus||data.year)?{releases:{some:{...(data.platform?{platformId:data.platform}:{}),
      ...(data.year?{releaseDate:data.year==="unknown"?"":{startsWith:data.year}}:{}),contents:{some:{item}}}}}:{})};
  const orders:Record<typeof librarySorts[number],Prisma.GameOrderByWithRelationInput>={added_desc:{createdAt:"desc"},added_asc:{createdAt:"asc"},title_asc:{title:"asc"},title_desc:{title:"desc"},updated_desc:{updatedAt:"desc"}};
  // 所有排序均以稳定 ID 收尾；组合拥有筛选必须命中同一个条目。
  return {where,orderBy:[orders[data.sort],{id:"asc"}] as Prisma.GameOrderByWithRelationInput[],page:data.page};
}
