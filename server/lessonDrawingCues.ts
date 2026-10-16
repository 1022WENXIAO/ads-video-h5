import type {LessonChapter} from '../shared/types';
import type {HtmlDrawing} from './narrativeScenes';

export type DrawingCueTimes = Readonly<Record<string, number>>;

/** The lesson caller supplies the already verified, lead-shifted chapter.
 * Never infer timing from drawing order, a prefix, or a repeated spoken cue.
 * An empty map intentionally leaves every authored emphasis static. */
export function lessonDrawingCueTimes(chapter:LessonChapter,drawing:HtmlDrawing,duration:number):DrawingCueTimes {
  const times:Record<string,number>=Object.create(null);
  if(!chapter.cues?.length)return times;
  const companions=new Set((drawing.serverCardLabels||[]).map(binding=>binding.labelId));
  const labels=new Map((drawing.serverCardLabels||[]).map(binding=>[binding.cardId,binding.text]));
  const nodes=drawing.nodes.filter(node=>!companions.has(node.id)&&node.kind!=='line'&&node.kind!=='path')
    .map(node=>({node,text:(labels.get(node.id)??node.text).trim()}));
  for(const {node,text} of nodes){
    if(!node.highlight||!text||nodes.filter(value=>value.text===text).length!==1)continue;
    const items=chapter.visual.items.filter(item=>item.label.trim()===text||item.cue.trim()===text);
    if(items.length!==1)continue;
    const cueText=items[0].cue.trim(),occurrence=chapter.narration.indexOf(cueText);
    if(!cueText||occurrence<0||chapter.narration.indexOf(cueText,occurrence+1)>=0)continue;
    const cues=chapter.cues.filter(cue=>cue.text.trim()===cueText);
    if(cues.length!==1)continue;
    const {start,end}=cues[0];
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration)continue;
    times[node.id]=start;
  }
  return times;
}
