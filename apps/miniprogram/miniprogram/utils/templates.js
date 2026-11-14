const mentionPattern = /(?:^|\s)[@＠]([^\s@＠，。！？,;；:：]{1,64})(?=$|[\s，。！？,;；:：])/g;

function draftMentions(text, templates) {
  return Array.from(text.matchAll(mentionPattern)).flatMap(match => {
    const template = templates.find(item => item.id === match[1] || item.name === match[1]);
    if (!template) return [];
    const end = match.index + match[0].length;
    return [{ template, start: end - match[1].length - 1, end: text[end] === ' ' ? end + 1 : end }];
  });
}

function selectedTemplateName(text, templates) {
  const first = draftMentions(text, templates)[0];
  return first ? first.template.name : '';
}

function withoutTemplateMentions(text, templates) {
  for (const { start, end } of draftMentions(text, templates).reverse()) {
    text = text.slice(0, start) + text.slice(end);
  }
  return text.trimStart();
}

function galleryCards(templates, client) {
  return templates.map(template => {
    const sample = template.sample;
    const video = sample ? client.templateAssetUrl(sample.videoUrl) : '';
    const poster = sample ? client.templateAssetUrl(sample.posterUrl) : '';
    return {
      id: template.id, name: template.name, description: template.description,
      format: template.output === 'game' ? '交互游戏' : '视频模板',
      seconds: template.defaults.seconds,
      sample: video && poster ? { title: sample.title, author: sample.source.author, video, poster } : null,
    };
  }).sort((left, right) => Number(Boolean(right.sample)) - Number(Boolean(left.sample)));
}

module.exports = { selectedTemplateName, withoutTemplateMentions, galleryCards };
