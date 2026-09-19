#!/usr/bin/env python3
"""Export source-only historical snapshots. Never check out or write the source repositories."""
import hashlib, io, json, pathlib, subprocess, sys, tarfile
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
cocos = '/Users/rydia/Project/cocos4/moonshort-4'
backend = '/Users/rydia/Project/mob.ai/git/moonshort-backend-cdotlock'
cases = [
  dict(id='cocos-event-listeners', repo=cocos, fix='da4128a3', paths=['assets/bundles/app'],
       targets=['assets/bundles/app/core/EventBus.ts'],
       prompt='Fix EventBus: a synchronous throwing listener currently stops later listeners, and a rejecting asynchronous listener becomes an unhandled rejection. Isolate and log both failures without recursively emitting an error event; preserve listener removal during dispatch and existing API behavior.'),
  dict(id='cocos-request-replay', repo=cocos, fix='fa8bb3c9', paths=['assets/bundles/app'],
       targets=['assets/bundles/app/core/StoryRequestQueue.ts'],
       prompt='Fix StoryRequestQueue: persistent transient network failures are retried forever and block subsequent tasks in that session. Allow the original attempt plus at most three backed-off retries; then reject that task and let the queue continue. Preserve per-session FIFO, cross-session independence, cancellation and non-retryable behavior.'),
  dict(id='backend-attribute-aliases', repo=backend, fix='550a4e7e', paths=['app','services','engine','__tests__'],
       targets=['app/core/game-rules.ts','app/lib/attribute-slots.ts','app/services/save-service.ts'],
       test='__tests__/lib/attribute-slots.test.ts',
       prompt='Fix legacy checking-attribute names: Brave checks using CHA/INT/ATK can fail because attribute lookup only matches novel display names. Keep exactly three physical checking slots; support stable aliases (CHA/charisma to SWEET, INT/intelligence to SMART, ATK/combat/STR to BOLD), canonical names and custom novel names. Explicit novel names win collisions. Reads, writes, labels and engine attribute projections must agree; unknown names still fail. Use the existing regression tests.'),
  dict(id='backend-oauth-basepath', repo=backend, fix='bb6e429c', paths=['cloudflare/backend-ring-router'],
       targets=['cloudflare/backend-ring-router/src/index.mjs'],
       test='cloudflare/backend-ring-router/test/backend-ring-router.test.mjs',
       prompt='Fix OAuth release-ring handling through the web base path. Google and Facebook browser routes under /web/api/auth/... must retain the same ring/ticket behavior as the corresponding /api/auth/... routes. Preserve existing native and unprefixed behavior. Use the existing worker regression tests with mocked requests; do not contact deployed services.'),
]
def git(repo,*args): return subprocess.check_output(['git','-C',repo,*args])
def export(case,rev,dest):
    dest.mkdir(parents=True,exist_ok=False)
    # Filter before export, so binary assets never enter the archive either.
    names=git(case['repo'],'ls-tree','-r','-z','--name-only',rev,'--',*case['paths']).decode().split('\0')
    def is_source(name):
        p=pathlib.PurePosixPath(name)
        return (name and not p.is_absolute() and '..' not in p.parts
                and not any(part in ('node_modules','dist','build','archive','prisma') for part in p.parts)
                and p.suffix in ('.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.sql'))
    selected=[name for name in names if is_source(name)]
    if not selected: raise ValueError('No source files selected')
    archive=git(case['repo'],'archive',rev,'--',*selected)
    count=0; size=0
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar:
            p=pathlib.PurePosixPath(member.name)
            if not member.isfile() or '..' in p.parts or p.is_absolute(): continue
            if any(part in ('node_modules','dist','build','archive','prisma') for part in p.parts): continue
            if p.suffix not in ('.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.sql'): continue
            data=tar.extractfile(member).read(); out=dest/p
            out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(data)
            count+=1; size+=len(data)
    if case.get('test'):
        p=dest/case['test'];p.parent.mkdir(parents=True,exist_ok=True)
        p.write_bytes(git(case['repo'],'show',case['fix']+':'+case['test']))
    return dict(files=count,bytes=size)
manifest=[]
for case in cases:
    case['fix']=git(case['repo'],'rev-parse',case['fix']).decode().strip()
    case['base']=git(case['repo'],'rev-parse',case['fix']+'^').decode().strip()
    case['originalHead']=git(case['repo'],'rev-parse','HEAD').decode().strip()
    case['originalDiffSha256']=hashlib.sha256(git(case['repo'],'diff','HEAD','--binary')).hexdigest()
    entry=dict(case)
    for version in ('base','fix'):
        dest=root/'snapshots'/case['id']/version
        entry[version+'Export']=export(case,case[version],dest)
    manifest.append(entry)
(root/'cases.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps([{k:c[k] for k in ('id','base','fix','baseExport')} for c in manifest],indent=2))
