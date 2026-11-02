#!/usr/bin/env python3
"""Create a self-contained editable project; never overwrite an existing directory."""
import argparse,json,shutil
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('destination',type=Path);p.add_argument('--scene',choices=['compression','activations'],default='compression');p.add_argument('--author',help='Footer signature, e.g. by张三制作');p.add_argument('--bgm',type=Path,help='Copy your own local background music into the project')
a=p.parse_args();dest=a.destination.expanduser().absolute();source=Path(__file__).resolve().parents[1]/'assets/starter'
if dest.exists():p.error('Destination already exists; choose a new version directory')
if a.bgm and not a.bgm.expanduser().is_file():p.error('BGM does not exist')
shutil.copytree(source,dest)
for file in (dest/'configs').glob('*.json'):
 cfg=json.loads(file.read_text(encoding='utf8'))
 if a.author is not None:cfg['author']=a.author
 if a.bgm:
  music=a.bgm.expanduser().resolve();copied=dest/'audio'/('custom'+music.suffix);shutil.copy2(music,copied);cfg['bgm']='../audio/'+copied.name
 file.write_text(json.dumps(cfg,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'project':str(dest),'config':'configs/'+a.scene+'.json','commands':['npm install','npm run preview','npm run render -- configs/'+a.scene+'.json','npm run verify -- configs/'+a.scene+'.json']},ensure_ascii=False,indent=2))
