import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
export async function fileDigest(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function artifactDigest(directory:string):Promise<string>{
 const hash=createHash('sha256');
 const walk=async(relative:string)=>{for(const name of (await readdir(path.join(directory,relative))).sort()){
  const file=path.join(relative,name),absolute=path.join(directory,file),stat=await lstat(absolute);
  if(stat.isSymbolicLink())throw Error('构建产物不能包含符号链接。');
  if(stat.isDirectory())await walk(file);else if(stat.isFile()){hash.update(file.split(path.sep).join('/'));hash.update('\0');hash.update(await readFile(absolute));hash.update('\0');}
 }};await walk('');return hash.digest('hex');
}
