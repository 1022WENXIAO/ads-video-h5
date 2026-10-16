import type {LessonChapter,LessonVisual} from '../src/types';

export type CoffeeIllustrationObject='machine'|'group-head'|'portafilter'|'filter'|'cup'|'beans'|'counter';
export interface LessonIllustrationSubject {
  controller:boolean;
  coffeeObjects:CoffeeIllustrationObject[];
  ambiguous:boolean;
}

// A handle names a component, not its owner. Use the current published chapter
// only to resolve a locally named component; never add its other objects.
export function lessonIllustrationSubject(item:LessonVisual['items'][number],chapter?:Pick<LessonChapter,'title'|'narration'>):LessonIllustrationSubject {
  const local=item.label+' '+item.detail,context=chapter?chapter.title+' '+chapter.narration:'';
  const coffeeEntity=/咖啡机|咖啡杯|咖啡豆|冲煮头|萃取头|粉碗|滤杯|手冲|\b(?:espresso|portafilter|dripper)\b|group\s*head|coffee\s*(?:machine|cup|beans)/i;
  const coffeeDomain=/咖啡|意式|手冲|滤杯|\b(?:coffee|espresso|portafilter|dripper)\b|group\s*head/i;
  const gameEntity=/游戏(?:手柄|控制器|摇杆|握把)|电子游戏|电玩|\b(?:GameCube|Xbox|PlayStation|DualSense)\b|Joy[ -]?Con|game\s*(?:controller|pad)/i;
  const gameContext=/游戏|电玩|\b(?:GameCube|Xbox|PlayStation|DualSense)\b|Joy[ -]?Con|game\s*(?:controller|pad|console)/i;
  const deniedGame=/(?:不是|并非|而非|不使用|不要(?:画|用)?|无需|非)\s*(?:游戏(?:手柄|控制器|摇杆)|电玩|GameCube|Xbox|PlayStation|DualSense)|\bnot\s+(?:a\s+)?(?:game\s*(?:controller|pad)|GameCube|Xbox|PlayStation|DualSense)/i;
  const deniedCoffee=/(?:不是|并非|而非|不使用|不要(?:画|用)?|无需|不需要|非)\s*(?:咖啡机|咖啡杯|咖啡豆|冲煮头|萃取头|portafilter)|\bnot\s+(?:an?\s+)?(?:coffee\s*(?:machine|cup)|portafilter)/i;
  const neutralHandle=/(?:^|[\s，。；、：,;:]|和|与|及)(?:金属)?(?:手柄|摇杆|握把)/;
  const neutralCoffeeHandle=/(?:^|[\s，。；、：,;:]|和|与|及)(?:金属)?手柄/;
  // A compound component name in the label already names its owner. A later
  // short reference in the detail cannot reassign it using the chapter topic.
  // Unknown compounds stay unknown; this does not enumerate other objects.
  const owners=item.label.split(/(?:[^\p{L}\p{N}]+|和|与|及)/u).flatMap(part=>{
    const match=part.match(/^([\p{L}\p{N}]*?)(?:手柄|摇杆|控制器|握把|把手|柄)/u);
    if(!match||!match[1]||match[1]==='金属')return [];
    const prefix=match[1];return [/(?:咖啡机?|冲煮头?|萃取头?|过滤)(?:的)?(?:金属)?$/.test(prefix)?'coffee':/(?:游戏|电玩|GameCube|Xbox|PlayStation|DualSense)(?:的)?(?:金属)?$/i.test(prefix)?'game':'unknown'];
  });
  if(owners.includes('unknown')||owners.includes('coffee')&&owners.includes('game'))return {controller:false,coffeeObjects:[],ambiguous:true};
  if(deniedCoffee.test(local))return {controller:false,coffeeObjects:[],ambiguous:true};
  const namedController=/手柄|摇杆|控制器|握把|\bcontroller\b|game\s*pad|Joy[ -]?Con|DualSense/i;
  const localCoffee=owners.includes('coffee')||coffeeEntity.test(local),localGame=(owners.includes('game')||gameEntity.test(local))&&namedController.test(local)&&!deniedGame.test(local);
  if(localCoffee&&localGame)return {controller:false,coffeeObjects:[],ambiguous:true};
  if(localGame)return {controller:true,coffeeObjects:[],ambiguous:false};
  const coffee=localCoffee||coffeeDomain.test(local)||(coffeeEntity.test(context)||coffeeDomain.test(context))&&!deniedCoffee.test(context);
  const game=gameContext.test(context)&&!deniedGame.test(context);
  if(neutralHandle.test(local)&&game&&!coffee&&!deniedGame.test(local))return {controller:true,coffeeObjects:[],ambiguous:false};
  if(!coffee)return {controller:false,coffeeObjects:[],ambiguous:false};
  // Conflicting chapter contexts cannot assign an otherwise ambiguous handle.
  if(game&&!localCoffee)return {controller:false,coffeeObjects:[],ambiguous:true};
  const objects:CoffeeIllustrationObject[]=[];
  if(/咖啡机|espresso\s*machine|coffee\s*machine/i.test(local))objects.push('machine');
  if(/冲煮头|萃取头|group\s*head/i.test(local))objects.push('group-head');
  if(/粉碗|\bportafilter\b|(?:咖啡机?|冲煮|过滤)(?:的)?手柄/i.test(local)||neutralCoffeeHandle.test(local)||owners.includes('coffee')&&/(?:手柄|柄)/.test(item.label))objects.push('portafilter');
  if(/滤杯|手冲|滤纸|pour[ -]?over|\bdripper\b/i.test(local))objects.push('filter');
  if(/杯子|杯具|杯壁|咖啡杯|[水瓷纸凉冷热温]杯|coffee\s*cup|\bcups?\b/i.test(local))objects.push('cup');
  if(/咖啡豆|coffee\s*beans/i.test(local))objects.push('beans');
  if(/台面|countertop/i.test(local))objects.push('counter');
  return {controller:false,coffeeObjects:objects,ambiguous:false};
}
