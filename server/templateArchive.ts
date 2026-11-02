import { deflateRawSync } from 'node:zlib';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small UTF-8 ZIP writer for bounded, server-created project files. No external CLI dependency. */
export async function archiveTemplateProject(directory: string, output: string) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset=0, count=0;
  async function add(dir: string) {
    for (const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(dir,entry.name);
      if (entry.isDirectory()) { await add(file); continue; }
      if (!entry.isFile()) continue;
      const bytes=await readFile(file), data=deflateRawSync(bytes), name=Buffer.from(path.relative(directory,file).split(path.sep).join('/'));
      const crc=crc32(bytes), header=Buffer.alloc(30), record=Buffer.alloc(46);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(8,8); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(name.length,26);
      record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20,4); record.writeUInt16LE(20,6); record.writeUInt16LE(0x800,8); record.writeUInt16LE(8,10); record.writeUInt32LE(crc,16); record.writeUInt32LE(data.length,20); record.writeUInt32LE(bytes.length,24); record.writeUInt16LE(name.length,28); record.writeUInt32LE(offset,42);
      local.push(header,name,data); central.push(record,name); offset+=header.length+name.length+data.length; count++;
    }
  }
  await add(directory);
  const end=Buffer.alloc(22), centralBytes=Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count,8); end.writeUInt16LE(count,10); end.writeUInt32LE(centralBytes.length,12); end.writeUInt32LE(offset,16);
  await writeFile(output,Buffer.concat([...local,centralBytes,end]),{mode:0o600,flag:'wx'});
}
