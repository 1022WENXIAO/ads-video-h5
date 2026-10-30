#!/usr/bin/env python3
"""Execute only the human-approved 2026-10-31 release cleanup, after verified backup."""
import argparse,datetime,fcntl,hashlib,json,os,pathlib,shutil,tarfile,gzip

parser=argparse.ArgumentParser()
parser.add_argument('--manifest',type=pathlib.Path,required=True)
parser.add_argument('--apply',action='store_true')
parser.add_argument('--resume-backup',action='store_true')
args=parser.parse_args()
assert os.geteuid()==0
manifest=json.loads(args.manifest.read_text())
base=pathlib.Path('/opt/qingjian-cn/releases')
targets=[pathlib.Path(value) for value in manifest['targets']]
assert len(targets)==len(set(targets))==manifest['targetCount']==26
assert set(manifest['retained'])=={str(base/'021b26f7d0db3fd10aa621ac79eeffe8ac272416'),str(base/'e86f833f8651b8caeba40eedecfe2643eff6bb03')}
def digest(file):
 h=hashlib.sha256()
 with open(file,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def validate():
 assert str(pathlib.Path('/opt/qingjian-cn/current').resolve())==manifest['current']
 for target in targets:
  assert target.parent==base and len(target.name)==40 and all(c in '0123456789abcdef' for c in target.name)
  assert target.is_dir() and not target.is_symlink() and str(target) not in manifest['retained']
 for proc in pathlib.Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  for name in ('cwd','exe'):
   try:
    value=os.readlink(proc/name)
    assert not any(value==str(t) or value.startswith(str(t)+'/') for t in targets),f'Active process {proc.name} references cleanup target'
   except OSError:pass
  for name in ('cmdline','maps'):
   try:
    value=(proc/name).read_bytes()
    assert not any(str(t).encode() in value for t in targets),f'Active process {proc.name} references cleanup target'
   except OSError:pass
validate()
if not args.apply:print(json.dumps({'mode':'preview','targets':len(targets),'freeGiB':round(shutil.disk_usage('/').free/2**30,2)}));raise SystemExit(0)
with open('/run/lock/qingjian-cn-deploy.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 validate()
 state=json.loads(pathlib.Path('/data/qingjian/app-state.json').read_text())
 assert not any(j['status'] in ('queued','running','stopping') for j in state['jobs']),'Active production jobs; retry cleanup after they finish'
 evidence=pathlib.Path('/opt/qingjian-cn/operator-evidence/ant-browser-install-20261031');evidence.mkdir(mode=0o700,exist_ok=True);evidence.chmod(0o700)
 archive=evidence/'approved-old-releases.tar.gz';assert not archive.exists() or args.resume_backup,'Backup already exists; inspect prior run before retrying'
 source_hashes={};source_links={}
 before=shutil.disk_usage('/').free
 stores={name:digest(pathlib.Path('/data/qingjian')/name) for name in ('app-state.json','auth.json','credits.json')}
 def inspect(info):
  parts=pathlib.PurePosixPath(info.name).parts
  if 'node_modules' in parts or '.git' in parts:return None
  file=base/pathlib.Path(*parts)
  if info.isfile() or info.islnk():source_hashes[info.name]=digest(file)
  elif info.issym():source_links[info.name]=info.linkname
  return info
 try:
  if args.resume_backup:
   assert archive.is_file()
   for target in targets:
    for root,dirs,files in os.walk(target,followlinks=False):
     dirs[:]=sorted(d for d in dirs if d not in ('node_modules','.git'))
     for name in dirs+sorted(files):
      if name in ('node_modules','.git'):continue
      file=pathlib.Path(root)/name;key=str(file.relative_to(base))
      if file.is_symlink():source_links[key]=os.readlink(file)
      elif file.is_file():source_hashes[key]=digest(file)
   print(json.dumps({'phase':'source-manifest','files':len(source_hashes)}),flush=True)
  else:
   with tarfile.open(archive,'w:gz',compresslevel=1,dereference=False) as tar:
    for i,target in enumerate(targets):
     tar.add(target,arcname=target.name,filter=inspect)
     assert shutil.disk_usage('/').free>200*1024*1024,'Backup would exhaust disk; no directories deleted'
     print(json.dumps({'phase':'backup','completed':i+1,'total':len(targets)}),flush=True)
  archive.chmod(0o600)
  checked=set();checked_links=set();archived_hashes={}
  with tarfile.open(archive,'r|gz') as tar:
   for item in tar:
    if item.isfile() or item.islnk():
     if item.islnk():value=archived_hashes[item.linkname]
     else:
      h=hashlib.sha256();f=tar.extractfile(item);assert f is not None
      for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
      value=h.hexdigest()
     assert value==source_hashes[item.name],item.name
     archived_hashes[item.name]=value
     checked.add(item.name)
    elif item.issym():assert item.linkname==source_links[item.name];checked_links.add(item.name)
  assert checked==set(source_hashes) and checked_links==set(source_links)
  with gzip.open(archive,'rb') as compressed:
   for _ in iter(lambda:compressed.read(1024*1024),b''):pass
 except BaseException:
  archive.unlink(missing_ok=True);raise
 backup={'archive':str(archive),'sha256':digest(archive),'bytes':archive.stat().st_size,'regularFilesVerified':len(checked),'symlinksVerified':len(checked_links),'excluded':['node_modules','.git'],'sourceHashes':source_hashes,'sourceSymlinks':source_links,'approvedManifest':manifest}
 proof=evidence/'backup-verification.json';proof.write_text(json.dumps(backup,indent=2));proof.chmod(0o600)
 print(json.dumps({k:v for k,v in backup.items() if k not in ('sourceHashes','sourceSymlinks','approvedManifest')}),flush=True)
 validate()
 for target in targets:shutil.rmtree(target)
 assert all(not target.exists() for target in targets)
 assert all(pathlib.Path(value).is_dir() for value in manifest['retained'])
 after=shutil.disk_usage('/').free
 result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'deleted':manifest['targets'],'retained':manifest['retained'],'archive':str(archive),'archiveSha256':backup['sha256'],'regularFilesVerified':len(checked),'freeGiBBefore':round(before/2**30,2),'freeGiBAfter':round(after/2**30,2),'productionStoreHashesUnchanged':{name:digest(pathlib.Path('/data/qingjian')/name)==value for name,value in stores.items()},'current':str(pathlib.Path('/opt/qingjian-cn/current').resolve())}
 proof=evidence/'cleanup-result.json';proof.write_text(json.dumps(result,indent=2));proof.chmod(0o600)
 print(json.dumps(result),flush=True)
