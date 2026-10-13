import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const tokenPath=()=>resolve(process.env.SETUP_TOKEN_FILE??".data/setup-token");
let pending:Promise<void>=Promise.resolve();
// 初始化共用串行锁，避免同时创建多个管理员。
export async function withBootstrapLock<T>(action:()=>Promise<T>):Promise<T>{
  const previous=pending;let release!:()=>void;
  pending=new Promise<void>(r=>{release=r;});
  await previous;try{return await action();}finally{release();}
}
export async function getSetupToken(){
  try{return (await readFile(tokenPath(),"utf8")).trim();}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return process.env.SETUP_TOKEN??"";}
}
