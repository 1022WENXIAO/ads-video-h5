#!/usr/bin/env python3
"""Read-only preflight. Never downloads, installs, deletes, or restarts services."""
import argparse,json,pathlib,platform,shutil,subprocess
parser=argparse.ArgumentParser();parser.add_argument('--manifest',type=pathlib.Path,default=pathlib.Path(__file__).with_name('cleanup-plan-20261031.json'));args=parser.parse_args()
data=json.loads(args.manifest.read_text());base=pathlib.Path('/opt/qingjian-cn/releases')
assert platform.system()=='Linux' and platform.machine() in ('x86_64','amd64')
current=pathlib.Path('/opt/qingjian-cn/current').resolve();assert str(current)==data['current']
for value in data['targets']:
 p=pathlib.Path(value);assert p.parent==base and len(p.name)==40 and all(c in '0123456789abcdef' for c in p.name) and not p.is_symlink() and p.is_dir();assert p!=current and str(p) not in data['retained']
mem={row.split(':')[0]:int(row.split()[1]) for row in pathlib.Path('/proc/meminfo').read_text().splitlines()}
state=json.loads(pathlib.Path('/data/qingjian/app-state.json').read_text())
print(json.dumps({'mode':'read-only','current':str(current),'cleanupTargets':len(data['targets']),'freeDiskGiB':round(shutil.disk_usage('/').free/2**30,2),'memoryMiB':mem['MemTotal']//1024,'availableMemoryMiB':mem['MemAvailable']//1024,'activeJobs':[{'id':j['id'],'status':j['status']} for j in state['jobs'] if j['status'] in ('queued','running','stopping')],'recommendedFreeDiskGiBBeforeInstall':5,'recommendedMemoryMiB':8192,'lowMemoryUnit':{'MemoryMaxMiB':768,'maxBrowserInstances':1}},ensure_ascii=False))
