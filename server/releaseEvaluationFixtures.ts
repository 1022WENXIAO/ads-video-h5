import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EvaluationFixture } from '../shared/evaluationTypes';
import type { Evaluations } from './evaluations';
import { evaluationFileHash, EvaluationError } from './evaluations';
import { getModelConfig, type ModelConfig } from './modelRegistry';
import { generateAudio } from './providers';
import { probeVideo, runFFmpeg } from './core';
import { throwIfJobCancelled } from './jobExecution';

const fixtureVersion = 'controlled-spoken-v1';
const lines = [
  '观察一个现象时，先记录看到了什么，再提出可能的解释。这段画面是程序绘制的示意，不是真实现场。把观察和推测分开，可以让表达更清楚，也让后续核验有明确的方向。',
  '比较两个方案时，要先保持比较条件一致，再看差异来自哪里。这段画面也是程序绘制的示意。结论应当由证据支持，暂时没有把握的部分，需要保留限制，不能把猜测说成事实。',
];

/** Persistent real MP4s and real synthesized speech, never fake analyses or passing artifacts. */
export async function ensureReleaseEvaluationFixtures(evaluations: Evaluations, dataDir: string, dependencies: { audioConfig?: ModelConfig; generateSpeech?: typeof generateAudio } = {}): Promise<EvaluationFixture[]> {
  const candidates = evaluations.catalog().fixtures.filter(f => f.name.startsWith(`${fixtureVersion}-`) && f.hasAudio && f.duration >= 12);
  const existing: EvaluationFixture[] = [];
  for (const fixture of candidates) {
    throwIfJobCancelled();
    try {
      // Catalog metadata cannot establish that a cached source still exists.
      const source = path.join(dataDir, 'evaluations', 'fixtures', fixture.id);
      if ((await stat(source)).size !== fixture.bytes || await evaluationFileHash(source) !== fixture.sha256) continue;
      const probe = await probeVideo(source);
      if (probe.hasAudio && probe.duration >= 12 && !existing.some(f => f.name === fixture.name)) existing.push(fixture);
    } catch { throwIfJobCancelled(); /* Missing, unreadable or corrupt cached movies must be rebuilt. */ }
  }
  if (['1','2'].every(n => existing.some(f => f.name === `${fixtureVersion}-${n}.mp4`))) return ['1','2'].map(n => existing.find(f => f.name === `${fixtureVersion}-${n}.mp4`)!);
  const audioConfig = dependencies.audioConfig || await getModelConfig('audio');
  if (!audioConfig) throw new EvaluationError('自动剪辑验收缺少受控视频素材且配音模型未配置，无法创建真实原声素材。');
  const directory = path.join(dataDir, 'evaluations', 'controlled-fixtures', fixtureVersion);
  await mkdir(directory, { recursive: true });
  const fixtures: EvaluationFixture[] = [];
  for (let i = 0; i < 2; i++) {
    throwIfJobCancelled();
    const name = `${fixtureVersion}-${i + 1}.mp4`, bound = existing.find(f => f.name === name);
    if (bound) { fixtures.push(bound); continue; }
    const speech = path.join(directory, `${i + 1}.audio`), video = path.join(directory, name);
    let bytes: Buffer;
    try { bytes = await readFile(speech); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const reference = i ? await readFile(path.join(directory, '1.audio')) : undefined;
      bytes = (await (dependencies.generateSpeech || generateAudio)(`${reference ? '使用@Audio1相同说话者、音色和录音环境。' : ''}生成清晰自然的普通话讲解，只朗读台词，不要背景音乐。台词：${lines[i]}`, audioConfig, reference)).bytes;
      const temporary = `${speech}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary,speech);
    }
    throwIfJobCancelled();
    await runFFmpeg(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`testsrc2=size=640x360:rate=24,drawbox=x=${i ? 'iw/2' : 'iw/4'}:y=ih/4:w=iw/5:h=ih/2:color=${i ? 'orange' : 'cyan'}:t=fill`,'-i',speech,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-shortest',video]);
    const probe = await probeVideo(video);
    if (!probe.hasAudio || probe.duration < 12) throw new EvaluationError('受控剪辑素材的真实音轨或时长不足，不能跳过剪辑验收。');
    fixtures.push(await evaluations.saveFixture(video, name));
  }
  return fixtures;
}
