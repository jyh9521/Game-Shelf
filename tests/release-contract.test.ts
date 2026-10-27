import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("发布版本在 package、锁文件、Compose 与 Unraid 中一致",()=>{
  const pkg=JSON.parse(readFileSync("package.json","utf8"));
  const lock=JSON.parse(readFileSync("package-lock.json","utf8"));
  assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
  assert.equal(lock.version,pkg.version);assert.equal(lock.packages[""].version,pkg.version);
  const image=`jyh9521/gameshelf:${pkg.version}`;
  assert.ok(readFileSync("compose.yaml","utf8").split(/\r?\n/).some(line=>line.trim()===`image: ${image}`));
  assert.ok(readFileSync("unraid/gameshelf.xml","utf8").includes(`<Repository>${image}</Repository>`));
});

test("Linux 容器入口保持 LF，Git checkout 不引入 CRLF",()=>{
  const entry=readFileSync("docker/entrypoint.sh","utf8");
  assert.ok(entry.startsWith("#!/bin/sh\n"));assert.ok(!entry.includes("\r"));
  assert.ok(readFileSync(".gitattributes","utf8").includes("*.sh text eol=lf"));
});
