import { mkdirSync, existsSync, writeFileSync, openSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
mkdirSync(".data",{recursive:true});
if(!existsSync(".data/gameshelf.db"))closeSync(openSync(".data/gameshelf.db","a"));
if(!existsSync(".env")){
  writeFileSync(".env",`DATABASE_URL="file:../.data/gameshelf.db"\nSETUP_TOKEN="${randomBytes(24).toString("hex")}"\nSECURE_COOKIE=false\n`,{flag:"wx",mode:0o600});
  console.log("CREATED .env and .data; initialization credential is in .env (not printed)");
}else console.log("PRESERVED existing .env");
