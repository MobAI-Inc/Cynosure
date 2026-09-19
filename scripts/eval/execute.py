#!/usr/bin/env python3
"""Run unchanged Aider/Exercism Python tests behind the macOS sandbox boundary."""
import json
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
PYTHON = ROOT / '.cynosure/tools/benchmark/bin/python'

def execute(source, output, artifact):
    source, artifact = Path(source).resolve(), Path(artifact).resolve()
    config = json.loads((source / '.meta/config.json').read_text())
    solutions = config['files']['solution']
    if len(solutions) != 1 or Path(solutions[0]).name != solutions[0]:
        raise ValueError('Expected one Python solution file')
    blocks = re.findall(r'```(?:python|py)?\s*\n(.*?)```', output, flags=re.S)
    code = max(blocks, key=len) if blocks else output
    artifact.mkdir(parents=True, exist_ok=False)
    (artifact / 'candidate.py').write_text(code)
    with tempfile.TemporaryDirectory(prefix='cynosure-code-') as temp:
        work = Path(temp).resolve()
        exercise = work / 'exercise'
        exercise.mkdir()
        for name in config['files']['test']:
            shutil.copyfile(source / name, exercise / name)
        (exercise / solutions[0]).write_text(code)
        report = work / 'pytest.xml'
        runtime = PYTHON.resolve().parent.parent
        venv = PYTHON.parent.parent.resolve()
        # All writable state is confined to this disposable test directory. The
        # child has no credentials and cannot read the workspace, home or network.
        policy = f'''(version 1)
(allow default)
(deny network*)
(deny file-read* (subpath "/Users"))
(allow file-read* (subpath {json.dumps(str(work))}) (subpath {json.dumps(str(runtime))}) (subpath {json.dumps(str(venv))}))
(deny file-write*)
(allow file-write* (subpath {json.dumps(str(work))}) (literal "/dev/null"))
(deny file-write* {' '.join('(literal '+json.dumps(str(exercise / name))+')' for name in config['files']['test'])})
(deny process-exec)
(allow process-exec (literal {json.dumps(str(PYTHON))}) (literal {json.dumps(str(PYTHON.resolve()))}))
'''
        (work / 'policy.sb').write_text(policy)
        command = ['/usr/bin/sandbox-exec', '-f', str(work / 'policy.sb'), str(PYTHON), '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--tb=short', f'--junitxml={report}', *config['files']['test']]
        def limits():
            resource.setrlimit(resource.RLIMIT_CPU, (170, 175))
            resource.setrlimit(resource.RLIMIT_FSIZE, (16*1024*1024, 16*1024*1024))
        env = {'PATH': str(PYTHON.parent)+':/usr/bin:/bin','HOME':str(work),'TMPDIR':str(work),'PYTHONDONTWRITEBYTECODE':'1','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','PYTHONHASHSEED':'0','LANG':'en_US.UTF-8'}
        started = time.monotonic()
        try:
            r = subprocess.run(command, cwd=exercise, env=env, capture_output=True, text=True, timeout=180, preexec_fn=limits)
            code_status, output_log = r.returncode, r.stdout+r.stderr
        except subprocess.TimeoutExpired as exc:
            code_status, output_log = 124, 'Official test run timed out after 180 seconds.'
        counts = {'tests':0,'failures':0,'errors':0,'skipped':0}
        if report.exists():
            tree = ET.parse(report)
            for suite in tree.findall('.//testsuite'):
                for k in counts:counts[k]+=int(suite.attrib.get(k,0))
            shutil.copyfile(report, artifact / 'pytest.xml')
        result = {'source':'Aider Polyglot official pytest suite','exitCode':code_status,'allTestsPassed':code_status==0 and counts['tests']>0 and counts['skipped']==0,**counts,'elapsedMs':round((time.monotonic()-started)*1000),'testCommand':'pytest -q official test files','log':output_log[-12000:].replace(str(work),'<sandbox>')}
        (artifact / 'execution.json').write_text(json.dumps(result,indent=2))
        return result

if __name__=='__main__':
    request=json.load(sys.stdin)
    print(json.dumps(execute(request['source'],request['output'],request['artifact'])))
