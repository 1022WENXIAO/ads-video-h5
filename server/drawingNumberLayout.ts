/** Only standalone numeric labels; ordinary prose keeps its normal wrapping. */
export const numericDrawingText = (text: string) => /^[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[%％‰])?$/.test(text.replace(/\s/g, ''));

export function assertNumericDrawingNode(node: { id: string; kind: string; text: string; w: number; h: number; fontSize: number }): void {
  if (!numericDrawingText(node.text)) return;
  const padding = node.kind === 'card' ? 30 : node.kind === 'circle' ? 14 : 0;
  const minimumWidth = Math.ceil(node.text.trim().length * node.fontSize * .55 + padding);
  if (/[\r\n]/.test(node.text) || node.w < minimumWidth || node.h < node.fontSize * 1.3 + padding - 3) throw new Error('数字节点' + node.id + '的完整数值“' + node.text.replace(/\s/g, '') + '”必须单行显示；至少保留' + minimumWidth + 'px宽与现有' + node.fontSize + 'px字号，扩大合法宽度或重排，不能拆开数字或缩小字号。');
}

export const NUMERIC_DRAWING_CSS = '.node[data-qj-number]{white-space:nowrap;overflow-wrap:normal;word-break:normal}.node.text[data-qj-number]{padding:0}';

// The estimate above is only an early rejection. This uses actual loaded-font
// glyphs and the real content box, so a narrow axis cannot pass by wrapping.
export const NUMERIC_DRAWING_CHECK_SCRIPT = `document.fonts.ready.then(()=>{for(const node of document.querySelectorAll('[data-qj-number]')){const range=document.createRange();range.selectNodeContents(node);const style=getComputedStyle(node),box=node.getBoundingClientRect(),scale=node.offsetWidth?box.width/node.offsetWidth:1;const width=range.getBoundingClientRect().width/(scale||1),available=node.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);if(width>available+1)throw new Error('数字字形溢出：'+node.id+' '+node.textContent+' 实际'+width.toFixed(2)+'px>可用'+available.toFixed(2)+'px；保留数字与字号，加宽或重排。');}});`;
