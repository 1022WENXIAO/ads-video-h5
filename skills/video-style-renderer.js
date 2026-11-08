/* The same frame renderer is used for the catalog samples and user exports. */
(() => {
  const palettes = {
    interface: { paper: '#eef0e9', ink: '#142c27', accent: '#136e50', soft: '#cfe8ce', white: '#fcfdf7' },
    diagram: { paper: '#e9f0fa', ink: '#152945', accent: '#254cbd', soft: '#d7e4ff', white: '#f9fbff' },
    spatial: { paper: '#16132a', ink: '#f7f2ff', accent: '#cbb7ff', soft: '#382c63', white: '#29203f' },
    pixel: { paper: '#171a29', ink: '#fff2ca', accent: '#f5c96a', soft: '#383851', white: '#27283e' },
  };
  const clamp = n => Math.max(0, Math.min(1, n));
  const ease = n => 1 - (1 - clamp(n)) ** 3;
  const mix = (a, b, p) => a + (b - a) * p;

  window.drawStyleFrame = (canvas, spec, seconds) => {
    const { width, height } = canvas;
    const ctx = canvas.getContext('2d');
    const p = palettes[spec.style];
    const duration = spec.duration / spec.beats.length;
    const at = Math.min(spec.duration - 0.00001, Math.max(0, seconds));
    const index = Math.floor(at / duration);
    const t = at - index * duration;
    const beat = spec.beats[index];
    const portrait = height > width;
    const scale = width / (portrait ? 560 : 960);
    const W = width / scale, H = height / scale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const box = (x, y, w, h, r, color, stroke) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fillStyle = color;
      ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    };
    const line = (points, color, weight = 2) => {
      ctx.beginPath();
      for (const [i, point] of points.entries()) {
        if (i) ctx.lineTo(...point);
        else ctx.moveTo(...point);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = weight;
      ctx.stroke();
    };
    const text = (value, x, y, size, color, maxWidth, weight = 600) => {
      ctx.font = `${weight} ${size}px "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'top';
      ctx.fillText(value, x, y, maxWidth);
    };
    const paragraph = (value, x, y, size, maxWidth, maxLines, color, weight) => {
      ctx.font = `${weight} ${size}px "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif`;
      const tokens = value.match(/[A-Za-z0-9]+|./gu) || [];
      const lines = [''];
      for (const token of tokens) {
        const last = lines.length - 1;
        if (lines[last] && ctx.measureText(lines[last] + token).width > maxWidth) lines.push(token.trimStart());
        else lines[last] += token;
      }
      if (lines.length > maxLines) throw Error('模板文字超出排版容量，请缩短分镜标题或说明。');
      lines.forEach((value, i) => text(value, x, y + i * size * 1.24, size, color, maxWidth, weight));
    };
    const dot = (x, y, r, color) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    };

    ctx.fillStyle = p.paper; ctx.fillRect(0, 0, W, H);
    for (let y = 14; y < H; y += 26) for (let x = 14; x < W; x += 26) dot(x, y, 1, p.soft);
    const margin = portrait ? 38 : 50;
    const label = `0${index + 1}  /  ${beat.eyebrow}`;
    text(label, margin, 47, 15, p.accent, W - 2 * margin, 750);
    const textW = portrait ? W - 2 * margin : 372;
    const titleSize = portrait ? 56 : 49;
    ctx.save();
    ctx.globalAlpha = ease((t + 0.09) / 0.36);
    ctx.translate(0, (1 - ease(t / 0.53)) * 17);
    paragraph(beat.title, margin, portrait ? 108 : 134, titleSize, textW, 3, p.ink, 800);
    paragraph(beat.detail, margin, portrait ? 335 : 345, 19, textW, 3, p.ink, 500);
    ctx.restore();

    const gx = portrait ? margin : 462;
    const gy = portrait ? 455 : (H - 328) / 2;
    const gw = W - gx - margin;
    const gh = portrait ? Math.min(395, H - gy - 98) : 328;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(gw / 448, gh / 328);
    box(0, 0, 448, 328, 23, p.white, p.soft);
    ctx.beginPath(); ctx.roundRect(0, 0, 448, 328, 23); ctx.clip();
    if (spec.style === 'interface') {
      const active = Math.min(2, Math.floor(t / (duration / 3)));
      const local = (t / (duration / 3)) % 1;
      box(25, 25, 398, 278, 19, p.paper);
      [0, 1, 2].forEach(i => dot(45 + i * 10, 45, 3, p.accent));
      const x = mix(70, 83, ease(local)), w = [308, 288, 282][active];
      box(x, 105, w, 114, [33, 25, 19][active], p.soft);
      text(beat.labels[active], x + 21, 127, 23, p.ink, w - 42, 750);
      box(x + 21, 176, w - 42, 10, 5, p.white);
      box(x + 21, 176, (w - 42) * ease(local), 10, 5, p.accent);
      const cx = 112 + active * 94 + 25 * ease(local), cy = 243 - 27 * Math.sin(local * Math.PI);
      line([[cx, cy], [cx + 7, cy + 20], [cx + 11, cy + 12], [cx + 21, cy + 11], [cx, cy]], p.ink, 3);
      beat.labels.forEach((name, i) => text(name, 52 + i * 123, 267, 13, i === active ? p.accent : p.ink, 106));
    } else if (spec.style === 'diagram') {
      const nodes = [[90, 126], [224, 177], [357, 102]];
      const route = [[90,126], [156,126], [156,177], [224,177], [290,177], [290,102], [357,102]];
      line(route, p.soft, 8);
      nodes.forEach(([x, y], i) => {
        const amount = ease((t - i * 0.32 + 0.2) / 0.6);
        dot(x, y, 34, p.soft); dot(x, y, 11 + 17 * amount, p.accent);
        text(String(i + 1), x - 5, y - 9, 16, p.white, 20, 750);
        text(beat.labels[i], x - 45, y + 46, 16, p.ink, 93);
      });
      const progress = ((t / duration) * 2.4) % 1 * (route.length - 1);
      const n = Math.floor(progress), m = progress - n;
      dot(mix(route[n][0], route[n+1][0], m), mix(route[n][1], route[n+1][1], m), 7, '#ee8e40');
      line([[45, 278], [403, 278]], p.soft, 3);
      line([[45, 278], [45 + ease(t / duration) * 358, 278]], p.accent, 3);
    } else if (spec.style === 'spatial') {
      const spin = t * 0.75 + index * 1.4;
      const project = (x, y, z) => {
        const xx = x * Math.cos(spin) - z * Math.sin(spin);
        const zz = x * Math.sin(spin) + z * Math.cos(spin);
        const depth = 530 / (530 + zz);
        return [224 + xx * depth, 145 + (y + zz * 0.29) * depth, zz];
      };
      for (let i = 0; i < 3; i++) {
        const y = -57 + i * 58 + Math.sin(t * 2.1 + i) * 9;
        const corners = [[-96,y,-65],[96,y,-65],[96,y,65],[-96,y,65]].map(v => project(...v));
        ctx.beginPath(); corners.forEach(([x, yy], n) => n ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy)); ctx.closePath();
        ctx.fillStyle = ['#7363bd', '#987fdf', '#bba5f8'][i]; ctx.fill();
        ctx.strokeStyle = '#e5d9ff'; ctx.lineWidth = 1.6; ctx.stroke();
        corners.forEach(([x, yy]) => dot(x, yy, 3.3, '#f1e5ff'));
      }
      beat.labels.forEach((name, i) => {
        box(34 + i * 130, 267, 119, 32, 7, p.soft);
        text(name, 43 + i * 130, 274, 14, p.ink, 99);
      });
    } else {
      const px = (x, y, w, h, color) => {
        ctx.fillStyle = color; ctx.fillRect(Math.round(x / 4) * 4, Math.round(y / 4) * 4, w * 4, h * 4);
      };
      for (let i = 0; i < 32; i++) px((i * 59 + 13) % 448, (i * 23) % 169 + 38, 1, 1, i % 3 ? '#535572' : '#eadbbb');
      px(0, 237, 112, 3, '#8c875c'); px(0, 248, 112, 18, '#33344b');
      for (let i = 0; i < 19; i++) px(i * 24, 259 + i % 3 * 8, 3, 1, '#49496b');
      const travel = ease(t / duration);
      const x = 53 + travel * 262;
      const y = 210 - 52 * Math.max(0, Math.sin(travel * Math.PI * 2));
      px(x + 5,y-23,5,4,p.accent); px(x,y-7,8,5,'#b67ef9'); px(x+21,y-19,1,1,p.paper);
      px(x+2,y+13,2,2,p.ink); px(x+22,y+13,2,2,p.ink);
      [138, 229, 328].forEach((goal, i) => {
        if (x < goal) { px(goal, 189 - i % 2 * 30, 3, 3, p.accent); return; }
        const fade = clamp((x - goal) / 72);
        for (let j = 0; j < 6; j++) {
          const a = j * Math.PI / 3;
          ctx.globalAlpha = 1 - fade;
          px(goal + Math.cos(a) * (8 + fade * 41), 190 + Math.sin(a) * (8 + fade * 41), 1, 1, p.accent);
        }
        ctx.globalAlpha = 1;
      });
      beat.labels.forEach((name, i) => text(name, 35 + i * 129, 274, 15, p.ink, 116));
    }
    ctx.restore();
    const footer = H - 40;
    line([[margin, footer - 12], [W - margin, footer - 12]], p.soft, 2);
    line([[margin, footer - 12], [margin + (W - margin * 2) * at / spec.duration, footer - 12]], p.accent, 2);
    text(spec.title, margin, footer, 12, p.ink, W - margin * 2, 650);
  };
})();
