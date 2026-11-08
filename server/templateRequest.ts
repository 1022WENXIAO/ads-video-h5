import type { Session } from '../shared/types';
import { selectMention, templateMentions } from '../shared/videoTemplates';
import type { VideoTemplateEntry } from './videoTemplates';
import {wantsScheduleManagement} from './scheduleIntent';
import { classify, wantsConversation, wantsPlanOnly } from './intents';

export function resolveTemplateRequest(text:string,_session:Pick<Session,'templateId'>,templates:VideoTemplateEntry[]) {
  if(wantsScheduleManagement(text))throw new Error('模板制作暂不支持定时执行，请移除定时要求后再发送。');
  const explicit=selectMention(text,templates);
  let kind=classify(text);
  if(kind==='review'||kind==='understanding')return {kind};
  if(explicit){
    let request=text;for(const m of templateMentions(text).reverse())request=request.slice(0,m.start)+request.slice(m.end);
    if(!request.replace(/[\s，。！？,;；:：]/gu,'').length)throw new Error('选好模板后，请补充要制作的视频主题。');
  }
  if(explicit&&!wantsConversation(text))kind=wantsPlanOnly(text)?'plan':'export';
  return {kind,template:explicit};
}
