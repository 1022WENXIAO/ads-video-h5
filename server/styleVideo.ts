import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { Type } from 'typebox';
import type { StyleVideoPlan } from '../shared/styleVideo';
import type { WorkflowEvent } from '../shared/types';
import { fileDigest } from './artifactIntegrity';
import { getAgent, runFFmpeg } from './core';
import { onJobAbort, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { runRequiredTool } from './requiredTool';
import { capture, scienceBrowser } from './scienceRender';
import { taskContext, taskRequestText } from './taskContract';
import { currentTaskExecution } from './taskRuntime';
import { stateHash } from './durableState';
import { archiveTemplateProject } from './templateArchive';
import { createToolTrace } from './toolTrace';
import { styleRenderer, templateSelection, type LoadedVideoTemplate } from './videoTemplates';
import { wantsPlanOnly } from './intents';

const formats = { '16:9': [960, 540], '9:16': [540, 960], '1:1': [720, 720] } as const;
const fps = 30;
const boundedText = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const planSchema = Type.Object({
  title: boundedText(36),
  duration: Type.Integer({ minimum: 6, maximum: 30 }),
  format: Type.Union([Type.Literal('16:9'), Type.Literal('9:16'), Type.Literal('1:1')]),
  beats: Type.Array(Type.Object({
    eyebrow: boundedText(12),
    title: boundedText(18),
    detail: boundedText(38),
    labels: Type.Array(boundedText(8), { minItems: 3, maxItems: 3 }),
  }), { minItems: 3, maxItems: 3 }),
});

export async function renderStyleVideo(
  plan: StyleVideoPlan,
  directory: string,
  template?: LoadedVideoTemplate,
  progress?: (frames: number, total: number) => Promise<void>,
) {
  throwIfJobCancelled();
  const [width, height] = formats[plan.format];
  const total = plan.duration * fps;
  const project = path.join(directory, 'project');
  const frames = path.join(directory, 'frames');
  await mkdir(project, { recursive: true });
  await mkdir(frames);
  const file = path.join(directory, 'video.mp4');
  const cover = path.join(directory, 'cover.png');
  const archive = path.join(directory, 'project.zip');
  const { puppeteer, executablePath } = await scienceBrowser();
  const browser = await puppeteer.launch({
    headless: true, executablePath, protocolTimeout: 45000,
    args: ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions',
      ...(process.env.QINGJIAN_RENDER_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
  });
  const kill = () => { browser.process()?.kill('SIGKILL'); };
  const unbind = onJobAbort(kill);
  const timer = setTimeout(kill, 180000);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request: { abort: () => Promise<void> }) => { void request.abort(); });
    await page.setContent(`<canvas width="${width}" height="${height}"></canvas>`);
    await page.addScriptTag({ content: await readFile(styleRenderer, 'utf8') });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const render = (time: number) => page.evaluate(({ spec, time }: { spec: StyleVideoPlan; time: number }) => {
      const canvas = document.querySelector('canvas')!;
      (window as unknown as { drawStyleFrame: (canvas: HTMLCanvasElement, plan: StyleVideoPlan, t: number) => void }).drawStyleFrame(canvas, spec, time);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { spec: plan, time }).then((png: string) => Buffer.from(png, 'base64'));
    for (let frame = 0; frame < total; frame++) {
      throwIfJobCancelled();
      const bytes = await render(frame / fps);
      await writeFile(path.join(frames, `frame-${String(frame).padStart(4, '0')}.png`), bytes);
      if (frame === Math.round(fps * .85)) await writeFile(cover, bytes);
      if (frame % 30 === 0) await progress?.(frame, total);
    }
  } catch (error) {
    await rm(frames, { recursive: true, force: true });
    throwIfJobCancelled();
    throw error;
  } finally {
    clearTimeout(timer);
    unbind();
    const closing = setTimeout(kill, 1500);
    try { await browser.close(); } finally { clearTimeout(closing); }
  }
  try {
    await runFFmpeg(['-nostdin', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps),
      '-i', path.join(frames, 'frame-%04d.png'), '-frames:v', String(total), '-c:v', 'libx264',
      '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], 120000);
  } finally {
    await rm(frames, { recursive: true, force: true });
  }
  const ffprobe = createRequire(import.meta.url)('ffprobe-static').path as string;
  const { streams } = JSON.parse((await capture(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file])).toString());
  const video = streams[0];
  if (streams.length !== 1 || video.codec_name !== 'h264' || video.width !== width || video.height !== height ||
      Number(video.nb_read_frames) !== total || video.avg_frame_rate !== '30/1' || Math.abs(Number(video.duration) - plan.duration) > .04) {
    throw new Error('风格成片的画幅、帧数或时长检查未通过。');
  }
  const sampleFrame = Math.floor(total / 3);
  const framesToCheck = [Math.floor(sampleFrame / 4), Math.floor(sampleFrame / 2), sampleFrame + 10, sampleFrame * 2 + 10];
  const raw = await capture(ffmpeg || 'ffmpeg', ['-v', 'error', '-i', file,
    '-vf', `select='${framesToCheck.map(n => `eq(n,${n})`).join('+')}',scale=160:90`,
    '-vsync', '0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  const frameBytes = 160 * 90 * 3;
  if (raw.length !== framesToCheck.length * frameBytes) throw new Error('无法解码风格成片的抽样帧。');
  let changed = 0;
  for (let i = 0; i < frameBytes; i++) if (Math.abs(raw[i] - raw[i + frameBytes]) > 15) changed++;
  if (changed / frameBytes < .003) throw new Error('首幕主体运动不足，请重新渲染风格成片。');

  const verification = {
    technicalPassed: true, userAccepted: false, width, height, fps, decodedFrames: total,
    duration: plan.duration, sampledFrames: framesToCheck, firstSceneChangedChannels: changed / frameBytes,
    videoSha256: await fileDigest(file), animationMode: 'code' as const,
    programSourceSha256: stateHash({ plan, renderer: await fileDigest(styleRenderer) }),
    ...(template ? { skill: templateSelection(template) } : {}),
  };
  const config = JSON.stringify(plan, null, 2);
  await Promise.all([
    copyFile(styleRenderer, path.join(project, 'renderer.js')),
    writeFile(path.join(project, 'config.json'), config),
    writeFile(path.join(project, 'verification.json'), JSON.stringify(verification, null, 2)),
    writeFile(path.join(project, 'index.html'), `<!doctype html><meta charset="utf-8"><title>风格视频工程</title>
<style>body{background:#111;margin:0;display:grid;place-items:center;min-height:100vh}canvas{max-width:100vw;max-height:100vh}</style>
<canvas width="${width}" height="${height}"></canvas><script src="renderer.js"></script>
<script type="application/json" id="spec">${config.replace(/</g, '\\u003c')}</script>
<script>const spec=JSON.parse(document.getElementById('spec').textContent),canvas=document.querySelector('canvas');
const start=performance.now();function draw(t){drawStyleFrame(canvas,spec,((t-start)/1000)%spec.duration);requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>`),
  ]);
  await archiveTemplateProject(project, archive);
  return { file, cover, archive, verification };
}

async function styleContactSheet(file: string, duration: number) {
  return capture(ffmpeg || 'ffmpeg', ['-v', 'error', '-i', file,
    '-vf', `fps=6/${duration},scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=3x2`,
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']);
}

export async function runStyleVideo(o: {
  template: LoadedVideoTemplate; prompt: string; config: ModelConfig; directory: string;
  previous?: StyleVideoPlan; progress: (events: WorkflowEvent[]) => Promise<void>;
  renderProgress?: (frames: number, total: number) => Promise<void>;
}) {
  const { template } = o;
  if (!template.style || !template.sample) throw new Error('风格模板缺少样片。');
  const style = template.style;
  const trace = createToolTrace(o.progress, [o.config.apiKey]);
  const request = taskRequestText(o.prompt);
  const sample = path.join(template.directory, 'assets/sample.mp4');
  const vision = /^doubao-seed-2-1-/.test(o.config.modelId) || o.config.modelId === 'deepseek-v4-1-flash-261017';
  let draft: StyleVideoPlan | undefined;
  const exportOnly = /^(?:请|帮我)?\s*(?:生成成片|导出(?:当前|现有)?(?:方案|成片|视频)?)\s*[。！!]?$/u.test(request);
  if (exportOnly && o.previous?.style === style) draft = o.previous;
  if (!draft) {
    let read = false;
    const agent = getAgent(o.config, trace.wrap([
      {
        name: 'read_style_sample', label: '读取模板样片', description: '查看样片的真实关键帧与画面节奏。', parameters: Type.Object({}),
        execute: async () => {
          const sheet = vision ? await styleContactSheet(sample, template.defaults.seconds) : undefined;
          const samplePlan = JSON.parse(await readFile(path.join(template.directory, 'assets/sample.json'), 'utf8')) as StyleVideoPlan;
          read = true;
          const details = {
            title: template.sample!.title, source: template.sample!.source,
            duration: samplePlan.duration, sampleTimes: [1, 3, 5, 7, 9, 11], notes: template.context,
            scenes: samplePlan.beats.map((beat, i) => ({ from: i * 4, to: (i + 1) * 4, ...beat })),
            observedFramesAvailable: Boolean(sheet),
          };
          return { details, content: [{ type: 'text' as const, text: JSON.stringify(details) },
            ...(sheet ? [{ type: 'image' as const, mimeType: 'image/jpeg', data: sheet.toString('base64') }] : [])] };
        },
      },
      {
        name: 'submit_style_plan', label: '提交三幕分镜', description: '提交用于实际渲染的主题、画幅、时长及三幕画面。', parameters: planSchema,
        execute: async (_id, input) => {
          if (!read) throw new Error('请先读取模板样片。');
          draft = { ...(input as Omit<StyleVideoPlan, 'style'>), style };
          return { content: [{ type: 'text', text: '分镜已提交。' }], details: { title: draft.title } };
        },
      },
    ]), `你是所选模板「${template.name}」的短片分镜作者。先调用 read_style_sample，再调用 submit_style_plan。
制作规则：${template.context}
三幕等分时长，默认 12 秒 16:9，可制作 6–30 秒，支持 16:9、9:16、1:1。固定可视化元素由所选样式渲染。每幕标题、说明和三个标签用用户的语言，保持精简。只写与用户主题有关的内容。输出为动画与文字，样片是风格资料。`, true, { maxTokens: 3200, inputImages: vision });
    await runRequiredTool(agent, request + (o.previous ? '\n上一版分镜：' + JSON.stringify(o.previous) : ''), {
      name: 'submit_style_plan', label: '生成风格分镜', done: () => Boolean(draft),
      config: o.config, secrets: [o.config.apiKey], maxTurns: 8, maxRejections: 3, timeoutMs: 120000,
    });
  }
  if (!draft) throw new Error('未生成风格分镜。');
  const plan = draft as StyleVideoPlan;
  if (wantsPlanOnly(request)) return { draft: plan };
  const rendered = await trace.run('render_style_video', '按模板渲染并检查视频', { style, format: plan.format }, () =>
    renderStyleVideo(plan, o.directory, template, o.renderProgress));
  const task = currentTaskExecution();
  const projectHash = stateHash(plan);
  await task?.verify('technical', projectHash, rendered.verification);
  let review: { approved: boolean; summary: string } | undefined;
  let evidenceRead = false;
  const reviewer = getAgent(o.config, trace.wrap([
    {
      name: 'read_style_render', label: '检查实际成片', description: '查看三幕分镜和实测成片证据。', parameters: Type.Object({}),
      execute: async () => {
        const sheet = vision ? await styleContactSheet(rendered.file, plan.duration) : undefined;
        const details = { plan, technical: rendered.verification, observedFramesAvailable: Boolean(sheet) };
        evidenceRead = true;
        return { details, content: [{ type: 'text' as const, text: JSON.stringify(details) },
          ...(sheet ? [{ type: 'image' as const, mimeType: 'image/jpeg', data: sheet.toString('base64') }] : [])] };
      },
    },
    {
      name: 'submit_style_review', label: '提交成片自检', description: '判定主题、明确约束和对应风格是否满足。',
      parameters: Type.Object({ approved: Type.Boolean(), summary: boundedText(300) }),
      execute: async (_id, input) => {
        if (!evidenceRead) throw new Error('先读取本次成片证据。');
        review = input as { approved: boolean; summary: string };
        return { details: review, content: [{ type: 'text', text: review.summary }] };
      },
    },
  ]), `独立检查选中的「${template.name}」模板成片。先读成片证据，再对照用户要求和制作规则检查三幕主题、明确时长及画幅等约束。
${template.context}
技术信息显示视频为三幕程序动画，无口播、无配乐。仅依据实际证据；没有图像时只能审阅分镜和技术指标。未满足用户明确要求时拒绝通过并具体说明。`, true,
    { role: 'reviewer', maxTokens: 1800, inputImages: vision });
  await runRequiredTool(reviewer, task ? taskContext(task.spec) + '\n本轮操作（以本轮明确要求为准）：' + request : request, {
    name: 'submit_style_review', label: '风格成片独立自检', done: () => Boolean(review),
    config: o.config, secrets: [o.config.apiKey], maxTurns: 6, maxRejections: 2, timeoutMs: 90000,
  });
  const decision = review as { approved: boolean; summary: string } | undefined;
  if (!decision?.approved) throw new Error('风格成片自检未通过：' + (decision?.summary || '缺少审阅结果。'));
  await task?.verify('requirements', projectHash, decision);
  await task?.accept({ projectHash, artifactHash: rendered.verification.videoSha256, technicalPassed: true, requirementsReviewed: true });
  return { draft: plan, rendered: { ...rendered, verification: { ...rendered.verification, review: decision } } };
}
