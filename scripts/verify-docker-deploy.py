from pathlib import Path
import sys, subprocess, json, hashlib, difflib, tarfile
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'engineering/docker-deploy'
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()
def config(path,mode):
    cmd=['docker','compose','--project-directory',str(ROOT),'-f',str(path),'config','--format','json']
    r=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8');assert r.returncode==0,r.stderr
    s=json.loads(r.stdout)['services']['gameshelf']
    expected=None if mode in {'BASELINE','ROLLBACK'} else 'gameshelf:0.1.0'
    assert s.get('image')==expected and 'build' in s
    print(f'{mode} image={s.get("image") or "null"} build=true')
if len(sys.argv)>1:
    config(Path(sys.argv[1]),sys.argv[2]);raise SystemExit(0)
BEFORE=OUT/'compose.before.yaml'
assert sha(BEFORE)=='5069188c1b074c47d8bd1baa2df42da1fd78f91a92d2c4a62e0d2e74e43fa47e'
MOD=OUT/'MODIFIED_FILE.yaml';MOD.write_bytes((ROOT/'compose.yaml').read_bytes())
DIFF=OUT/'DIFF_FILE.diff'
DIFF.write_text(''.join(difflib.unified_diff(BEFORE.read_text(encoding='utf-8').splitlines(True),MOD.read_text(encoding='utf-8').splitlines(True),fromfile=str(BEFORE),tofile=str(ROOT/'compose.yaml'))),encoding='utf-8')
ROLLBACK=OUT/'ROLLBACK.sh'
ROLLBACK.write_text('''#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TARGET="${1:-$DIR/rollback-compose.yaml}"
EXPECTED="5069188c1b074c47d8bd1baa2df42da1fd78f91a92d2c4a62e0d2e74e43fa47e"
[[ "$(sha256sum "$DIR/compose.before.yaml" | cut -d ' ' -f 1)" == "$EXPECTED" ]]
cp -- "$DIR/compose.before.yaml" "$TARGET"
[[ "$(sha256sum "$TARGET" | cut -d ' ' -f 1)" == "$EXPECTED" ]]
echo "PASS ROLLBACK compose=original hash=matched live_container=unchanged"
''',encoding='utf-8',newline='\n')
BASH=r'C:\Program Files\Git\bin\bash.exe'
subprocess.run([BASH,'-c','chmod +x "$1" && test -x "$1"','_',ROLLBACK.as_posix()],check=True)
records=[]
def run(label,cmd,input=''):
    r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True,encoding='utf-8');assert r.returncode==0,(r.stdout,r.stderr)
    records.append(f'{label}\nCOMMAND: {subprocess.list2cmdline(cmd)}\nINPUT: {input}\nOUTPUT: {r.stdout.strip()}\nEXIT: {r.returncode}')
    return r.stdout.strip()
run('BASELINE',[sys.executable,str(Path(__file__).resolve()),str(BEFORE),'BASELINE'],'original Compose fixture')
run('MODIFIED',[sys.executable,str(Path(__file__).resolve()),str(MOD),'MODIFIED'],'Compose with image gameshelf:0.1.0')
TEST=OUT/'rollback-compose.yaml';TEST.write_bytes(MOD.read_bytes())
run('ROLLBACK',[BASH,ROLLBACK.as_posix(),TEST.as_posix()],'separate modified Compose copy')
run('RESTORED_BEHAVIOR',[sys.executable,str(Path(__file__).resolve()),str(TEST),'ROLLBACK'],'restored Compose copy')
assert sha(TEST)==sha(BEFORE) and sha(MOD)==sha(ROOT/'compose.yaml')
identity=run('IMAGE',['docker','image','inspect','gameshelf:0.1.0','--format','{{.Id}} {{.Os}}/{{.Architecture}}'],'built and save/load verified local image')
health=run('CONTAINER',['docker','inspect','gameshelf-gameshelf-1','--format','{{.State.Status}} {{.State.Health.Status}}'],'main container')
assert health=='running healthy'
tar=ROOT/'artifacts/gameshelf-0.1.0-linux-amd64.tar'
digest=sha(tar)
with tarfile.open(tar) as tf:
    manifest=json.load(tf.extractfile('manifest.json'))
    assert any('gameshelf:0.1.0' in v.get('RepoTags',[]) for v in manifest)
checksum=tar.with_suffix(tar.suffix+'.sha256')
checksum.write_text(f'{digest}  {tar.name}\n',encoding='ascii')
README=ROOT/'artifacts/README.md'
README.write_text(f'''# GameShelf Docker 镜像

镜像：gameshelf:0.1.0\n平台：linux/amd64\n镜像身份：{identity}\n镜像包：{tar.name}\nSHA256：{digest}\n大小：{tar.stat().st_size} bytes

已在 Docker Desktop 构建、启动、save/load、重建持久化和 UID/GID 99/100 条件下验证。尚未在真实 Unraid 上运行，未上传公共镜像仓库。

将镜像包与校验文件复制到目标服务器，校验 SHA256 后执行：

```sh
docker load -i gameshelf-0.1.0-linux-amd64.tar
```

加载后使用项目 unraid/gameshelf.xml 模板，或使用 Compose 并指定已加载的 gameshelf:0.1.0 镜像。模板默认宿主路径 /mnt/user/appdata/gameshelf，映射为 /data；实际路径、端口和 UID/GID 由目标设备配置决定。

首次初始化凭据位于持久化目录 setup-token，不是源码开发用 .env 中的凭据。普通游戏备份不包含账号密码和服务器凭据。镜像包本身不包含个人数据库、.env 或测试备份。
''',encoding='utf-8')
REPORT=OUT/'VERIFICATION.txt'
REPORT.write_text(f'''GameShelf Docker Desktop deployment
Changed field: compose.services.gameshelf.image -> gameshelf:0.1.0; build source retained.
MODIFIED_FILE: {MOD}
ACTIVE_FILE: {ROOT/'compose.yaml'}
DIFF_FILE: {DIFF}
VERIFICATION: {REPORT}
ROLLBACK: {ROLLBACK}
BASELINE_SHA256: {sha(BEFORE)}
MODIFIED_SHA256: {sha(MOD)}
RESTORED_SHA256: {sha(TEST)}
STATUS: rollback fixture restored original config; active Compose remains modified; main container running healthy.
NOTE: ROLLBACK.sh restores only a diagnostic Compose copy, does not stop live container or roll back database migrations.

DEPLOYMENT_COMMAND: docker build --tag gameshelf:0.1.0 .
DEPLOYMENT_RESULT: image built successfully; exit 0
START_COMMAND: docker compose up -d --no-build --wait --wait-timeout 180
START_RESULT: gameshelf-gameshelf-1 Healthy; exit 0
RECREATE_COMMAND: docker compose up -d --no-build --force-recreate --wait --wait-timeout 180
RECREATE_RESULT: PASS MAIN_RECREATE healthy=true setup_credential=preserved; exit 0
QA_API_COMMAND: node tests/api-integration.mjs
QA_API_RESULT: PASS API_INTEGRATION checks=58 auth=verified rollback=transactional backup=roundtrip duplicate=no; exit 0
QA_UI_COMMAND: node tests/ui-smoke.mjs
QA_UI_RESULT: PASS UI_SMOKE desktop=create mobile=no-overflow item=edited backup=downloaded console_errors=0 screenshots=4; exit 0
PERSISTENCE_COMMAND: node tests/docker-persistence.mjs after (after QA container delete/recreate with same named volume)
PERSISTENCE_RESULT: PASS DOCKER_PERSISTENCE phase=after games=2 items=4 recreated=identical; exit 0
STOP_RESTART_TEST: docker stop gameshelf-docker-qa; docker start gameshelf-docker-qa; both returned gameshelf-docker-qa; exit 0
PERMISSION_RESULT: PASS UNRAID_UID gid=100 uid=99 database=writable migrations=applied; exit 0
IMAGE_CONTENT_RESULT: PASS IMAGE_CONTENT no_env=true no_test_artifacts=true; exit 0
EXPORT_COMMAND: docker save --output artifacts/gameshelf-0.1.0-linux-amd64.tar gameshelf:0.1.0
EXPORT_RESULT: tar file created; exit 0
LOAD_COMMAND: docker load --input artifacts/gameshelf-0.1.0-linux-amd64.tar
LOAD_RESULT: Loaded image: gameshelf:0.1.0; image identity unchanged; exit 0
IMAGE_IDENTITY: {identity}
EXPORT_PATH: {tar}
EXPORT_SHA256: {digest}
EXPORT_BYTES: {tar.stat().st_size}
RUNNING_URL: http://127.0.0.1:3000
DATA_PATH: {ROOT/'.data/docker'}
INITIALIZATION_CREDENTIAL_FILE: {ROOT/'.data/docker/setup-token'} (value not logged)
REAL_UNRAID_TEST: not performed
REGISTRY_PUSH: not performed; local Docker Desktop deployment only

'''+ '\n\n'.join(records),encoding='utf-8')
for p in [MOD,DIFF,REPORT,ROLLBACK,README,checksum]:
    assert p.read_text(encoding='utf-8')
    print('REOPENED '+str(p))
print('REOPENED '+str(tar)+' manifest=gameshelf:0.1.0')
print(f'PASS DEPLOYMENT_VERIFIED image={identity} container={health} tar_sha256={digest}')
