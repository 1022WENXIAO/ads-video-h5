import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StyleVideoPlan } from '../shared/styleVideo';
import { renderStyleVideo } from '../server/styleVideo';
import { styleKinds } from '../server/videoTemplates';

const requested = process.argv.slice(2);
const kinds = requested.length ? styleKinds.filter(style => requested.includes(style)) : styleKinds;
if (!kinds.length) throw new Error('Specify interface, diagram, spatial or pixel.');
for (const style of kinds) {
  const assets = path.resolve('skills', `video-style-${style}`, 'assets');
  const plan = JSON.parse(await readFile(path.join(assets, 'sample.json'), 'utf8')) as StyleVideoPlan;
  const directory = await mkdtemp(path.join(tmpdir(), 'qj-style-sample-'));
  const result = await renderStyleVideo(plan, directory);
  await copyFile(result.file, path.join(assets, 'sample.mp4'));
  await copyFile(result.cover, path.join(assets, 'poster.png'));
  console.log(JSON.stringify({ style, ...result.verification, directory }));
}
