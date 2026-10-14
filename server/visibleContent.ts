// Editorial constraints belong in the design brief, never in audience copy.
// Keep this narrow: ordinary explanations such as “不把相关当因果” are valid.
export function assertVisibleContent(values: readonly unknown[]): void {
  const instruction = /实际审查要求|具体返修意图|内部(?:反馈|说明)|制作备注|按(?:审查|审核|反馈)(?:意见|要求|修改|修正)|(?:不与|不要|不能|不得|禁止|避免)[^。；\n]{0,28}(?:卡片|条目|图标|提示条|处理原因|说明文字)[^。；\n]{0,14}(?:合并|绑定|混排|显示|呈现|重复|遮挡)/;
  if (values.some(value => typeof value === 'string' && instruction.test(value))) {
    throw new Error('观众画面含内部制作或返修指令；只显示已核验事实与清楚解释，将避免事项留在内部绘图指令。');
  }
}
