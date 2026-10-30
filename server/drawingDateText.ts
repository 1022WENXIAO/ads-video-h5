/** Preserve authored dates as complete inline units. Surrounding prose may
 * still wrap, and no year or day is inferred for an incomplete date. */
export const drawingDateCopyId=(logicalId:string)=>'qj-date-copy-'+logicalId;
export function drawingDateText(text:string,escape:(value:string)=>string,logicalId?:string):string {
  const date=/(?<!\d)(?:\d{4}年)?(?:1[0-2]|0?[1-9])月(?:(?:3[01]|[12]\d|0?[1-9])日)?(?!\d)/g;
  let end=0,html='';
  for(const match of text.matchAll(date)){
    html+=escape(text.slice(end,match.index))+'<span data-qj-date>'+escape(match[0])+'</span>';end=match.index!+match[0].length;
  }
  return end?'<span class="qj-date-copy"'+(logicalId?' id="'+escape(drawingDateCopyId(logicalId))+'"':'')+'>'+html+escape(text.slice(end))+'</span>':escape(text);
}
export const DRAWING_DATE_CSS='.qj-date-copy{min-width:0;max-width:100%}[data-qj-date]{display:inline-block;white-space:nowrap;overflow-wrap:normal;word-break:normal}';
// A complete token that cannot fit is an actual geometry error. Do not hide
// the overflow or reduce its font to make the browser check pass.
export const DRAWING_DATE_CHECK_SCRIPT=`document.fonts.ready.then(()=>{for(const date of document.querySelectorAll('[data-qj-date]')){const node=date.closest('.node'),style=getComputedStyle(node),box=node.getBoundingClientRect(),scale=node.offsetWidth?box.width/node.offsetWidth:1,available=node.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),width=date.getBoundingClientRect().width/(scale||1);if(width>available+1)throw new Error('日期字形溢出：'+node.id+' '+date.textContent+'；保留完整日期和字号，加宽或重排。');}});`;
