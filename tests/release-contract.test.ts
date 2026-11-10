import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("发布版本在 package、锁文件、Compose 与 Unraid 中一致",()=>{
  const pkg=JSON.parse(readFileSync("package.json","utf8"));
  const lock=JSON.parse(readFileSync("package-lock.json","utf8"));
  assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
  assert.equal(lock.version,pkg.version);assert.equal(lock.packages[""].version,pkg.version);
  assert.equal(pkg.scripts["test:release"],`node tests/release-${pkg.version}.mjs`);
  const image=`jyh9521/gameshelf:${pkg.version}`;
  assert.ok(readFileSync("compose.yaml","utf8").split(/\r?\n/).some(line=>line.trim()==='image: "${GAMESHELF_IMAGE:-'+image+'}"'));
  assert.ok(readFileSync("unraid/gameshelf.xml","utf8").includes(`<Repository>${image}</Repository>`));
});

test("Linux 容器入口保持 LF，Git checkout 不引入 CRLF",()=>{
  const entry=readFileSync("docker/entrypoint.sh","utf8");
  assert.ok(entry.startsWith("#!/bin/sh\n"));assert.ok(!entry.includes("\r"));
  assert.ok(readFileSync(".gitattributes","utf8").includes("*.sh text eol=lf"));
});

test("所有外部服务变量在环境示例、Compose 和 Unraid 中同步，密钥不作为构建参数",()=>{
  const env=readFileSync(".env.example","utf8"), compose=readFileSync("compose.yaml","utf8"), unraid=readFileSync("unraid/gameshelf.xml","utf8");
  const dockerfile=readFileSync("Dockerfile","utf8"), dockerignore=readFileSync(".dockerignore","utf8");
  for(const key of ["IGDB_CLIENT_ID","IGDB_CLIENT_SECRET","RAWG_API_KEY","THEGAMESDB_API_KEY","SCREENSCRAPER_DEV_ID","SCREENSCRAPER_DEV_PASSWORD","SCREENSCRAPER_USERNAME","SCREENSCRAPER_PASSWORD","SCREENSCRAPER_SOFTNAME","STEAMGRIDDB_API_KEY","STEAM_WEB_API_KEY","GEMINI_API_KEY","GEMINI_MODEL"]){
    assert.ok(env.split(/\r?\n/).some(line=>line===(key+"="+(key==="SCREENSCRAPER_SOFTNAME"?"GameShelf":""))));
    assert.ok(compose.includes("      "+key+': "${'+key+":-"));
    const config=unraid.split(/\r?\n/).find(line=>line.includes('Target="'+key+'"'));
    assert.ok(config?.includes('Required="false"'));
    assert.ok(config?.includes('Mask="'+(["SCREENSCRAPER_SOFTNAME","GEMINI_MODEL"].includes(key)?"false":"true")+'"'));
    assert.ok(!dockerfile.includes(key));
  }
  assert.ok(dockerignore.split(/\r?\n/).includes(".env*"));
});
