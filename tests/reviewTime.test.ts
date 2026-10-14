import {test} from 'node:test';
import assert from 'node:assert/strict';
import {artifactReviewRequestedAt} from '../server/reviewTime';
import {newsPublicationScoringFixture} from './fixtures/newsPublicationScoring';
import type {ChatMessage} from '../src/types';

test('existing news reviews retain the original cutoff across midnight and legacy records recover only their own message',()=>{
  const {artifact,cutoffUtc}=newsPublicationScoringFixture();artifact.messageId='original';
  const messages:ChatMessage[]=[{id:'original',role:'user',text:'生成今天热点新闻视频',createdAt:cutoffUtc},{id:'followup',role:'user',text:'再审查',createdAt:'2026-10-16T02:00:00Z'}];
  assert.equal(artifactReviewRequestedAt(artifact,messages),Date.parse(cutoffUtc));
  artifact.requestedAt=undefined;
  assert.equal(artifactReviewRequestedAt(artifact,messages),Date.parse(cutoffUtc));
  assert.throws(()=>artifactReviewRequestedAt(artifact,messages.slice(1)),/缺少原始消息时间/);
  artifact.requestedAt='2026-10-16T02:00:00Z';
  assert.throws(()=>artifactReviewRequestedAt(artifact,messages),/原消息的指令时间不一致/);
  artifact.requestedAt='invalid';assert.throws(()=>artifactReviewRequestedAt(artifact,messages),/原始指令时间无效/);
});
