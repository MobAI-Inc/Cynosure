#!/usr/bin/env python3
"""Fetch pinned Aider cases and freeze promptfoo inputs; no authored test oracle."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1]).resolve()
if (OUT / 'cases.json').exists():
    raise SystemExit('Already frozen: choose a new output directory')
OUT.mkdir(parents=True, exist_ok=True)
plan = json.loads((ROOT / 'eval/plan.json').read_text())
selection = json.loads((ROOT / 'eval/coding-cases.json').read_text())
source_info = plan['sources']['polyglot']
archive = OUT / 'source.tar.gz'
url = f"https://codeload.github.com/{source_info['repo']}/tar.gz/{source_info['commit']}"
subprocess.run(['curl','--http1.1','-fL','--retry','2','--max-time','120',url,'-o',str(archive)],check=True)
source = OUT / 'source'
source.mkdir()
with tarfile.open(archive) as tar:
    # Extract only ordinary files/directories beneath the one archive root.
    for member in tar.getmembers():
        parts=Path(member.name).parts[1:]
        if not parts:continue
        relative=Path(*parts)
        if relative.is_absolute() or '..' in relative.parts or member.issym() or member.islnk():raise ValueError('Invalid archive member')
        target=source/relative
        if member.isdir():target.mkdir(parents=True,exist_ok=True)
        elif member.isfile():
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(tar.extractfile(member).read())
cases=[]
for name in sorted(selection['learning']+selection['heldout']):
    directory=source/'python/exercises/practice'/name
    config=json.loads((directory/'.meta/config.json').read_text())
    files=config['files']['solution']
    assert len(files)==1
    docs='\n'.join((directory/p).read_text() for p in ['.docs/introduction.md','.docs/instructions.md','.docs/instructions.append.md'] if (directory/p).exists())
    add=f"\n####\nUse the above instructions to modify the supplied files: {files[0]}\nDon't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\nOnly use standard libraries, don't suggest installing any packages.\n\nTo suggest changes to a file you MUST return the entire content of the updated file in a Python code block, preceded by the filename. Never omit unchanged code.\n"
    prompt=docs+add+f'\n{files[0]}\n```python\n'+(directory/files[0]).read_text()+'\n```'
    cases.append({'id':name,'subset':name,'split':'learn' if name in selection['learning'] else 'heldout','question':prompt,'source':str(directory),'solutionFile':files[0],'testFiles':config['files']['test'],'testSourceSha256':{f:hashlib.sha256((directory/f).read_bytes()).hexdigest() for f in config['files']['test']}})
# Runtime parameters and prices are explicit configuration, never inferred quality.
runtime=json.loads((ROOT/'eval/runtime.json').read_text())
for name,value in [('plan.json',plan),('runtime.json',runtime),('cases.json',cases)]:
    (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
manifest={name:hashlib.sha256((OUT/name).read_bytes()).hexdigest() for name in ['plan.json','runtime.json','cases.json']}
manifest['sourceArchiveSha256']=hashlib.sha256(archive.read_bytes()).hexdigest()
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
subprocess.run(['node',str(ROOT/'scripts/eval/configure.mjs'),str(OUT)],cwd=ROOT,check=True)
print(json.dumps({'out':str(OUT),'cases':len(cases),'heldout':len(selection['heldout'])}))
