import sys,json,re,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
phase=sys.argv[1]
out=[]
for p in sorted((root.parent/'supabase/tests/database').glob('*.sql')):
 r=subprocess.run(['docker','exec','-i','tugpt-security-remediation-pg17','psql','-X','-U','postgres','-d','security_review','-v','ON_ERROR_STOP=1','-At'],input=p.read_text(),text=True,capture_output=True)
 log=r.stdout+r.stderr;(root/'evidence'/f'{phase}-{p.name}.log').write_text(log)
 fails=[l.strip() for l in log.splitlines() if re.search(r'not ok \d|Looks like you|ERROR:',l)]
 out.append(dict(file=p.name,passed=r.returncode==0 and not fails,assertions=len(re.findall(r'(?m)^ok \d',log)),failures=fails))
(root/'evidence'/f'{phase}-regressions.json').write_text(json.dumps(out,indent=2))
print(phase,'suites:',len(out),'passed:',sum(t['passed'] for t in out),'passing assertions:',sum(t['assertions'] for t in out))
for t in out:
 if not t['passed']:print(t['file'],t['failures'])
