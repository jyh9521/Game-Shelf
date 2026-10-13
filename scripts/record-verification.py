from pathlib import Path
import subprocess, hashlib, difflib, json, sys
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'engineering'
BEFORE=OUT/'domain.before.ts'
MODIFIED=OUT/'MODIFIED_FILE.ts'
SOURCE=ROOT/'src/lib/domain.ts'
EXPECTED='2f9f4fffd7e1b63c42f754cceaa72ebb8d3110a4269ebd8f021674f08cf7f359'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(BEFORE)==EXPECTED
MODIFIED.write_bytes(SOURCE.read_bytes())
DIFF=OUT/'DIFF_FILE.diff'
DIFF.write_text(''.join(difflib.unified_diff(BEFORE.read_text(encoding='utf-8').splitlines(True),MODIFIED.read_text(encoding='utf-8').splitlines(True),fromfile=str(BEFORE),tofile=str(SOURCE))),encoding='utf-8')
ROLLBACK=OUT/'ROLLBACK.sh'
ROLLBACK.write_text('''#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SOURCE="$DIR/domain.before.ts"
TARGET="${1:-$DIR/MODIFIED_FILE.ts}"
EXPECTED="'''+EXPECTED+'''"
[[ "$(sha256sum "$SOURCE" | cut -d ' ' -f 1)" == "$EXPECTED" ]]
cp -- "$SOURCE" "$TARGET"
[[ "$(sha256sum "$TARGET" | cut -d ' ' -f 1)" == "$EXPECTED" ]]
echo "PASS ROLLBACK restored=original-date-validation hash=matched"
''',encoding='utf-8',newline='\n')
BASH=r'C:\Program Files\Git\bin\bash.exe'
subprocess.run([BASH,'-c','chmod +x "$1" && test -x "$1"','_',ROLLBACK.as_posix()],check=True)
CLI=ROOT/'node_modules/tsx/dist/cli.mjs'
records=[]
def execute(label,cmd,expected,input):
    r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True,encoding='utf-8')
    assert r.returncode==expected,(r.stdout,r.stderr)
    records.append(f'{label}\nCOMMAND: {subprocess.list2cmdline(cmd)}\nINPUT: {input}\nOUTPUT: {r.stdout.strip()}\nSTDERR: {r.stderr.strip()}\nEXIT: {r.returncode}')
for label,file,exitcode in [('BASELINE',BEFORE,1),('MODIFIED',MODIFIED,0)]:
    code=f"import {{date}} from '{file.as_posix()}'; const accepted=date.safeParse('2023-02-29').success;console.log('INPUT=2023-02-29 ACCEPTED='+accepted);process.exit(accepted?1:0);"
    execute(label,['node',str(CLI),'-e',code],exitcode,'2023-02-29 (invalid date)')
TEST=OUT/'rollback-date.ts';TEST.write_bytes(MODIFIED.read_bytes())
execute('ROLLBACK',[BASH,ROLLBACK.as_posix(),TEST.as_posix()],0,'separate modified date-validation copy')
code=f"import {{date}} from '{TEST.as_posix()}';const accepted=date.safeParse('2023-02-29').success;console.log('RESTORED_INPUT=2023-02-29 ACCEPTED='+accepted);process.exit(accepted?0:1);"
execute('RESTORED_BEHAVIOR',['node',str(CLI),'-e',code],0,'2023-02-29')
assert sha(TEST)==EXPECTED and sha(MODIFIED)==sha(SOURCE) and sha(SOURCE)!=EXPECTED
REPORT=OUT/'VERIFICATION.txt'
files=[p for p in ROOT.rglob('*') if p.is_file() and not any(part in {'.next','node_modules','.data','engineering','docker-revision','.git'} for part in p.relative_to(ROOT).parts)]
manifest={str(p.relative_to(ROOT)):sha(p) for p in files}
(OUT/'source-hashes.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
REPORT.write_text(f'''GameShelf first development milestone
Changed field: domain.date validator month/day + Gregorian leap-year validation. Restoring the original diagnostic copy reproduces its invalid-date acceptance; actual app remains fixed. ROLLBACK.sh covers this isolated source correction, not an application/database deployment downgrade.
MODIFIED_FILE: {MODIFIED}
ACTIVE_SOURCE: {SOURCE}
DIFF_FILE: {DIFF}
VERIFICATION: {REPORT}
ROLLBACK: {ROLLBACK}
ORIGINAL_SHA256: {EXPECTED}
MODIFIED_SHA256: {sha(MODIFIED)}
RESTORED_SHA256: {sha(TEST)}
STATUS: modified artifact and actual app retain fixed behavior; original diagnostic copy preserved.
Application: 0.1.0 core library milestone, not full MVP. Repository requirements use the archived v1.2 Docker/Unraid snapshot; the external requirements file is not overwritten by this code transaction.
No Git remote, commits, push or published image. Docker daemon was not available; Docker execution and actual Unraid acceptance remain unverified.
Results (see adjacent logs): unit tests 5/5; typecheck 0; production build successful; HTTP integration 58 checks; browser smoke desktop/mobile and backup downloaded; access isolation 6 checks; Compose config, shell syntax and Unraid XML passed; npm audit zero vulnerabilities.
Performance: separate synthetic Windows SQLite sample, 10000 games + 10000 library items. See benchmark.txt for measured results, not an Unraid/device promise.

'''+ '\n\n'.join(records),encoding='utf-8')
for p in [MODIFIED,DIFF,REPORT,ROLLBACK]:
    assert p.read_text(encoding='utf-8')
    print('REOPENED '+str(p))
print(REPORT.read_text(encoding='utf-8'))
