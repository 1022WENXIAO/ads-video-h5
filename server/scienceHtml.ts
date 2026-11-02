import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { LoadedVideoTemplate } from './videoTemplates';
import type { ScienceScene } from '../shared/scienceScene';

export async function scienceHtml(template:LoadedVideoTemplate,config:ScienceScene){
  const base=path.join(template.directory,'assets/integration');
  const names=['renderer','scene','motion-api','reference-effects','motion-metrics'];
  const contents=await Promise.all(names.map(name=>readFile(path.join(base,name+'.mjs'),'utf8')));
  const parts=Object.fromEntries(['renderer','scene','motion','reference','metrics'].map((key,i)=>[key,contents[i]]));
  const {buildScienceDocument}=await import(pathToFileURL(path.join(base,'project-builder.mjs')).href);
  return buildScienceDocument(parts,config) as string;
}
