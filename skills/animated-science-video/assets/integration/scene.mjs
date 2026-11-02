// Deterministic state interpreter: configuration is data, never executable model code.
export const clamp = v => Math.max(0, Math.min(1, v));
export function stepTime(cfg, panel, step) {
  return step === 0 ? 0 : 1 + (step - 1 + .75) * (cfg.duration - 2) / (panel.steps.length - 1);
}
export function stateAt(t, panelIndex, cfg) {
  const p = cfg.panels[panelIndex], span = (cfg.duration - 2) / (p.steps.length - 1);
  const step = t < 1 ? 0 : Math.min(p.steps.length - 1, 1 + Math.floor((t - 1) / span));
  const u = step === 0 ? 1 : clamp((t - 1 - (step - 1) * span) / (span * .75));
  const nodes = p.nodes.map(n => ({ ...n, visible: n.visible ?? true, active: n.active ?? false, alpha: 1 }));
  for (let j = 0; j <= step; j++) for (const change of p.steps[j].changes) {
    const n = nodes.find(n => n.id === change.nodeId), k = j === step ? u : 1;
    for (const axis of ['x', 'y']) if (change[axis] !== undefined) n[axis] += (change[axis] - n[axis]) * k;
    if (change.visible !== undefined && change.visible !== n.visible) { n.alpha = change.visible ? k : 1 - k; n.visible = k < 1 || change.visible; }
    if (k >= 1) for (const key of ['text', 'active']) if (change[key] !== undefined) n[key] = change[key];
  }
  return { nodes, step, u, span, stage: p.steps[step].label, transfers: p.transfers, color: p.color };
}

export function paintPanel(ui, x, y, s, panelIndex, t, rect) {
  const { w, h } = rect, innerW = w - 50, innerH = h - 154;
  const position = n => ({ x: x + 25 + n.x * innerW, y: y + 111 + n.y * innerH, w: n.w * innerW, h: n.h * innerH });
  for (const transfer of s.transfers) {
    const a = s.nodes.find(n => n.id === transfer.from), b = s.nodes.find(n => n.id === transfer.to);
    if (!a.visible || transfer.step > s.step) continue;
    const pa = position(a), pb = position(b), start = 1 + (transfer.step - 1) * s.span;
    const dx = pb.x-pa.x, dy = pb.y-pa.y, len = Math.max(1, Math.hypot(dx,dy));
    const points = [[pa.x + dx/len*Math.min(pa.w,pa.h)*.4, pa.y + dy/len*Math.min(pa.w,pa.h)*.4], [pb.x-dx/len*Math.min(pb.w,pb.h)*.4, pb.y-dy/len*Math.min(pb.w,pb.h)*.4]];
    ui.pulse(points, start, start + s.span*.75, s.color);
  }
  for (const n of s.nodes) {
    if (!n.visible) continue;
    const p = position(n), color = n.active ? s.color : ui.C.edge;
    ui.c.save(); ui.c.globalAlpha *= n.alpha;
    ui.c.font='400 22px "Animated CJK", "Noto Sans CJK SC", "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';
    if(ui.c.measureText(n.text).width>p.w-8)throw new Error(`面板${panelIndex+1}节点${n.id}的文字超过节点宽度，请增大w或精简text：${n.text}`);
    ui.box(p.x-p.w/2, p.y-p.h/2, p.w, p.h, color, n.active ? '#183047' : '#0d1522', n.kind === 'token' ? 5 : 9, n.active ? 2.4 : 1.3);
    ui.text(n.text, p.x, p.y+7, 22, n.active ? ui.C.text : ui.C.muted);
    ui.c.restore();
  }
}
