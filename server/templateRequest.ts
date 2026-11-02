import type { Session } from '../shared/types';
import { selectMention, templateMentions } from '../shared/videoTemplates';
import type { LoadedVideoTemplate } from './videoTemplates';
import {wantsScheduleManagement} from './scheduleIntent';
import { classify, wantsConversation, wantsPlanOnly } from './intents';

export function resolveTemplateRequest(text:string,session:Pick<Session,'templateId'>,templates:LoadedVideoTemplate[]) {
  if(wantsScheduleManagement(text))throw new Error('模板制作暂不支持定时执行，请移除定时要求后再发送。');
  const explicit=selectMention(text,templates);
  let kind=classify(text);
  if(kind==='review'||kind==='understanding')return {kind};
  const inherited=!explicit && session.templateId && !wantsConversation(text) && (kind==='export'||/^(?:请|帮我)?\s*(?:修改|调整|改成|改为|缩短|延长|重新制作|重新生成|换个|换成|修复|继续制作)/.test(text));
  const template=explicit||(inherited?templates.find(t=>t.id===session.templateId):undefined);
  if(explicit){
    let request=text;for(const m of templateMentions(text).reverse())request=request.slice(0,m.start)+request.slice(m.end);
    if(!request.replace(/[\s，。！？,;；:：]/gu,'').length)throw new Error('选好模板后，请补充要制作的视频主题。');
  }
  if(template&&!wantsConversation(text))kind=wantsPlanOnly(text)?'plan':'export';
  return {kind,template};
}
