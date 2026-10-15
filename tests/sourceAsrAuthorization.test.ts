import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AudioAnalysis, MediaItem } from '../shared/types';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';
import { recheckAuthorizedSource } from '../server/sourceAsrAuthorization';
import { SourceAsrRecoveryError, type SourceAsrRecoveryReason } from '../server/sourceAsrRecovery';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qingjian-source-authorization-'));
  const file = path.join(dir, 'owned-source');
  // Real file I/O exercises the authorization boundary, not media decoding.
  const bytes = Buffer.from('original source bytes for authorization testing');
  await writeFile(file, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const original: AudioAnalysis = {
    status: 'ready', modelId: 'controlled-no-provider', sourceHash: hash,
    duration: 3, transcript: '这不是真实现场', timing: 'model-estimated',
    createdAt: '2026-10-15T11:27:30.745Z', warnings: [], pauses: [],
    sentences: [{ id: 'source:sentence:0', start: 0, end: 3, text: '这不是真实现场', complete: true, words: [{ start: 0, end: 3, text: '这不是真实现场' }] }],
  };
  const item: MediaItem = { id: 'source', ownerId: 'owner', kind: 'video', mimeType: 'video/mp4', name: 'owned source', url: '/api/media/source', hasAudio: true, duration: 3, createdAt: original.createdAt, analysis: original };
  const media = [item];
  const reason: SourceAsrRecoveryReason = { kind: 'negation-boundary', sentenceIds: ['source:sentence:0'], sourceHash: hash, detail: 'Controlled authorization reason; no expected transcript sent.' };
  const candidate: AudioAnalysis = { ...structuredClone(original), createdAt: '2026-10-15T11:28:30.745Z', warnings: ['independent controlled candidate'] };
  const args = { ownerId: 'owner', sourceId: 'source', media, file, reason };
  return { dir, file, bytes, hash, original, item, media, candidate, args, close: () => rm(dir, { recursive: true, force: true }) };
}

test('owned exact source returns the candidate without changing original media, words, or file', async () => {
  const f = await fixture();
  try {
    let calls = 0; const before = JSON.stringify(f.item);
    const result = await recheckAuthorizedSource({ ...f.args, recheck: async (item, file, reason) => {
      calls++; assert.equal(item, f.item); assert.equal(file, f.file); assert.deepEqual(reason, f.args.reason);
      return f.candidate;
    } });
    assert.equal(calls, 1); assert.equal(result.item, f.item); assert.equal(result.analysis, f.candidate);
    assert.doesNotThrow(result.assertCurrent);
    assert.equal(f.item.analysis, f.original); assert.equal(JSON.stringify(f.item), before);
    assert.deepEqual(await readFile(f.file), f.bytes);
  } finally { await f.close(); }
});

test('the synchronous adoption guard rejects owner, analysis and audio changes after return', async t => {
  for (const name of ['owner', 'analysis', 'has-audio', 'has-audio-unset']) await t.test(name, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      const checked = await recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; return f.candidate; } });
      assert.doesNotThrow(checked.assertCurrent);
      if (name === 'owner') f.item.ownerId = 'other';
      if (name === 'analysis') f.original.sentences[0].words[0].text = 'concurrent independently changed word';
      if (name === 'has-audio') f.item.hasAudio = false;
      if (name === 'has-audio-unset') delete f.item.hasAudio;
      assert.throws(checked.assertCurrent, SourceAsrRecoveryError);
      assert.equal(calls, 1); assert.equal(f.item.analysis, f.original);
      assert.notEqual(f.item.analysis, checked.analysis, 'the helper/guard never adopts the stale candidate');
    } finally { await f.close(); }
  });
});

test('a promise-return microtask can pass old item checks but the final synchronous guard blocks adoption', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const checked = await recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; return f.candidate; } }).then(result => {
      // This runs after the helper's final checks and before the consumer's
      // await resumes, while the object and array membership remain unchanged.
      queueMicrotask(() => { f.item.ownerId = 'other'; });
      return result;
    });
    assert.equal(checked.item, f.item); assert.equal(f.media.includes(checked.item), true);
    assert.equal(f.item.ownerId, 'other');
    assert.throws(checked.assertCurrent, SourceAsrRecoveryError);
    assert.equal(calls, 1); assert.equal(f.item.analysis, f.original);
  } finally { await f.close(); }
});

test('unauthorized, missing, ambiguous and unready sources never invoke recheck', async t => {
  for (const name of ['wrong-owner', 'missing', 'duplicate', 'no-analysis', 'unready', 'image', 'no-audio']) await t.test(name, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      const args = { ...f.args };
      if (name === 'wrong-owner') args.ownerId = 'other';
      if (name === 'missing') args.sourceId = 'missing';
      if (name === 'duplicate') f.media.push({ ...f.item });
      if (name === 'no-analysis') delete f.item.analysis;
      if (name === 'unready') f.item.analysis!.status = 'no-audio';
      if (name === 'image') f.item.kind = 'image';
      if (name === 'no-audio') f.item.hasAudio = false;
      await assert.rejects(recheckAuthorizedSource({ ...args, recheck: async () => { calls++; return f.candidate; } }), SourceAsrRecoveryError);
      assert.equal(calls, 0);
    } finally { await f.close(); }
  });
});

test('original hash, actual bytes and reason sentence/hash bindings must agree before any call', async t => {
  for (const name of ['old-hash', 'changed-file', 'reason-hash', 'unknown-sentence', 'duplicate-sentence']) await t.test(name, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      if (name === 'old-hash') f.original.sourceHash = '0'.repeat(64);
      if (name === 'changed-file') await writeFile(f.file, 'different actual bytes');
      if (name === 'reason-hash') f.args.reason.sourceHash = '0'.repeat(64);
      if (name === 'unknown-sentence') f.args.reason.sentenceIds = ['another-source:sentence:0'];
      if (name === 'duplicate-sentence') f.args.reason.sentenceIds.push(f.args.reason.sentenceIds[0]);
      await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; return f.candidate; } }), SourceAsrRecoveryError);
      assert.equal(calls, 0);
    } finally { await f.close(); }
  });
});

test('a file changed while awaiting independent recognition cannot replace the old analysis', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => {
      calls++; await writeFile(f.file, 'source replaced during recognition'); return f.candidate;
    } }), SourceAsrRecoveryError);
    assert.equal(calls, 1); assert.equal(f.item.analysis, f.original);
  } finally { await f.close(); }
});

test('concurrent owner, item, analysis replacement and in-place edits are preserved and reject adoption', async t => {
  for (const name of ['owner', 'item', 'analysis-object', 'analysis-content']) await t.test(name, async () => {
    const f = await fixture();
    try {
      await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => {
        if (name === 'owner') f.item.ownerId = 'other';
        if (name === 'item') f.media[0] = { ...f.item };
        if (name === 'analysis-object') f.item.analysis = structuredClone(f.original);
        if (name === 'analysis-content') f.original.sentences[0].words[0].end = 2.5;
        return f.candidate;
      } }), SourceAsrRecoveryError);
      assert.notEqual(f.item.analysis, f.candidate);
      if (name === 'owner') assert.equal(f.item.ownerId, 'other');
      if (name === 'analysis-content') assert.equal(f.original.sentences[0].words[0].end, 2.5);
    } finally { await f.close(); }
  });
});

test('a media getter observes replacement of the whole application array', async () => {
  const f = await fixture();
  try {
    let media: MediaItem[] = f.media;
    await assert.rejects(recheckAuthorizedSource({ ...f.args, media: () => media, recheck: async () => {
      media = [{ ...f.item }]; return f.candidate;
    } }), SourceAsrRecoveryError);
    assert.equal(f.item.analysis, f.original);
  } finally { await f.close(); }
});

test('non-ready or different-source recognition results are never adopted', async t => {
  for (const name of ['unready', 'hash']) await t.test(name, async () => {
    const f = await fixture();
    try {
      const candidate = structuredClone(f.candidate);
      if (name === 'unready') candidate.status = 'no-audio'; else candidate.sourceHash = '0'.repeat(64);
      await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => candidate }), SourceAsrRecoveryError);
      assert.equal(f.item.analysis, f.original);
    } finally { await f.close(); }
  });
});

test('cancellation before/after the await stops adoption and preserves callback errors without retry', async t => {
  for (const where of ['before', 'during']) await t.test(where, async () => {
    const f = await fixture(); const controller = new AbortController();
    try {
      let calls = 0; if (where === 'before') controller.abort();
      await assert.rejects(runWithJobSignal(controller.signal, () => recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; controller.abort(); return f.candidate; } })), JobCancelledError);
      assert.equal(calls, where === 'before' ? 0 : 1); assert.equal(f.item.analysis, f.original);
    } finally { await f.close(); }
  });
  for (const error of [new Error('HTTP 401'), Object.assign(new Error('permission denied'), { code: 'EACCES' }), new JobCancelledError()]) await t.test(error.message, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; throw error; } }), failure => failure === error);
      assert.equal(calls, 1); assert.equal(f.item.analysis, f.original);
    } finally { await f.close(); }
  });
});

test('real file I/O errors retain their cause and do not invoke another recognition call', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; await unlink(f.file); return f.candidate; } }), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(calls, 1); assert.equal(f.item.analysis, f.original);
    await assert.rejects(recheckAuthorizedSource({ ...f.args, recheck: async () => { calls++; return f.candidate; } }), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(calls, 1);
  } finally { await f.close(); }
});
