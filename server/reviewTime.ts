import type {Artifact,ChatMessage} from '../src/types';

/** Reviewing a dated film must not move its request window to the follow-up
 * message. Legacy artifacts recover the time from their own original message. */
export function artifactReviewRequestedAt(artifact:Artifact,messages:ChatMessage[]):number{
  const stored=artifact.requestedAt===undefined?undefined:Date.parse(artifact.requestedAt);
  const original=messages.find(message=>message.id===artifact.messageId),messageTime=original?Date.parse(original.createdAt):undefined;
  if(stored!==undefined&&!Number.isFinite(stored))throw new Error('作品原始指令时间无效，保留记录后核对，不能使用当前时间替代。');
  if(artifact.plan?.lesson?.hotResearch&&stored!==undefined&&messageTime!==undefined&&stored!==messageTime)throw new Error('新闻作品与原消息的指令时间不一致，不能改变报道窗口。');
  const time=stored??messageTime;
  if(time!==undefined&&Number.isFinite(time))return time;
  if(artifact.plan?.lesson?.hotResearch)throw new Error('新闻作品缺少原始消息时间，无法按原时效重新审查。');
  const created=Date.parse(artifact.createdAt);
  if(!Number.isFinite(created))throw new Error('作品时间无效，不能推定重新审查时效。');
  return created;
}
