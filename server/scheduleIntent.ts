export function wantsScheduleManagement(text: string): boolean {
  // Quoted task contents and explanations are data, not scheduling commands.
  const request = text.replace(/[“「"][^”」"]*[”」"]/g, '');
  if (/^(?:(?:请|帮我)\s*)?(?:只)?(?:回复|解释|介绍|说明|讲解|描述|什么是|如何|怎么)/.test(request.trim())) return false;
  const operation = '设置|创建|新建|安排|添加|暂停|停止|恢复|启用|取消|删除|修改|调整|查看|列出|立即执行|立刻运行';
  return new RegExp(`(?:${operation}).{0,24}(?:定时|计划任务|自动任务)|(?:定时任务|计划任务|自动任务).{0,30}(?:${operation})|^(?:请|帮我)?\s*定时(?:执行|运行|生成|制作)`, 'i').test(request)
    || /(?:每天|每日|每周|每星期|每分钟|每小时|每(?:隔)?\s*[\d一二三四五六七八九十两]+\s*(?:分钟|小时)|[\d一二三四五六七八九十两]+\s*(?:分钟|小时)后|明天.{0,16}(?:点|:\d{2}))[^。！？!?；;\r\n]{0,80}(?:帮我|自动|执行|运行|生成|制作|搜集|搜索|整理|提醒(?:我|我们|一下))/.test(request)
    || /\b(?:schedule|pause|resume|delete|list|update)\b.{0,40}\b(?:task|job|daily|weekly|every|at)\b/i.test(request);
}
