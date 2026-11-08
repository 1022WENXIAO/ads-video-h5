import { useState } from 'react';
import { ArrowLeft, Layers3, Play, Search } from 'lucide-react';
import type { VideoTemplate } from '../shared/videoTemplates';
import './template-gallery.css';

const labels = {
  'zh-CN': {
    intro: '先看样片，再选风格。', search: '搜索模板', all: '全部模板', samples: '有样片',
    noResults: '没有找到匹配的模板。', preview: '看样片', use: '使用模板', back: '返回模板列表',
    sample: '样片', game: '交互游戏', video: '视频模板', source: '原作', related: '参考合集',
    failed: '样片暂时无法播放。', retry: '重新加载', seconds: '秒', noSample: '制作规则',
  },
  'en-US': {
    intro: 'Watch a sample, then choose a style.', search: 'Search templates', all: 'All templates', samples: 'With samples',
    noResults: 'No matching templates.', preview: 'Watch sample', use: 'Use template', back: 'Back to templates',
    sample: 'Sample', game: 'Interactive game', video: 'Video template', source: 'Original', related: 'Reference collection',
    failed: 'The sample could not be played.', retry: 'Reload', seconds: 'sec', noSample: 'Production template',
  },
};

export default function TemplateGallery({ templates, locale, assetUrl, onUse }: {
  templates: VideoTemplate[];
  locale: keyof typeof labels;
  assetUrl: (path: string) => string;
  onUse: (template: VideoTemplate) => void;
}) {
  const t = labels[locale];
  const [query, setQuery] = useState('');
  const [sampleOnly, setSampleOnly] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const [playError, setPlayError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const preview = templates.find(template => template.id === previewId);
  const sample = preview?.sample;
  const search = query.trim().toLowerCase();
  const matching = templates.filter(template => (!sampleOnly || template.sample) &&
    `${template.name} ${template.description} ${template.id}`.toLowerCase().includes(search))
    .sort((left, right) => Number(Boolean(right.sample)) - Number(Boolean(left.sample)));

  if (preview && sample) {
    return <section className="template-gallery gallery-detail" aria-label={sample.title} key={preview.id}>
      <button type="button" className="gallery-back" onClick={() => setPreviewId(undefined)}>
        <ArrowLeft size={16} />{t.back}
      </button>
      <div className="gallery-player">
        {playError
          ? <div className="gallery-play-error" role="status">
              <p>{t.failed}</p>
              <button type="button" onClick={() => { setAttempt(value => value + 1); setPlayError(false); }}>{t.retry}</button>
            </div>
          : <video key={attempt} controls playsInline preload="metadata" aria-label={sample.title}
              src={assetUrl(sample.videoUrl)} poster={assetUrl(sample.posterUrl)} onError={() => setPlayError(true)} />}
      </div>
      <div className="gallery-detail-copy">
        <div><span className="gallery-tag">{preview.name} · {t.sample}</span><h2>{sample.title}</h2><p>{preview.description}</p></div>
        <button type="button" className="gallery-primary" onClick={() => onUse(preview)}>{t.use}</button>
      </div>
      <div className="gallery-sources">
        <a href={sample.source.url} target="_blank" rel="noreferrer">{t.source} {sample.source.author}</a>
        <a href={sample.source.galleryUrl} target="_blank" rel="noreferrer">{t.related}</a>
      </div>
    </section>;
  }

  return <section className="template-gallery" aria-label={t.all} key="catalog">
    <div className="gallery-intro">
      <div className="gallery-mark"><Layers3 size={22} /></div>
      <h2>{t.intro}</h2>
      <label className="gallery-search">
        <Search size={17} />
        <input type="search" value={query} placeholder={t.search} aria-label={t.search} onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="gallery-filters">
        <button type="button" aria-pressed={!sampleOnly} onClick={() => setSampleOnly(false)}>{t.all}</button>
        <button type="button" aria-pressed={sampleOnly} onClick={() => setSampleOnly(true)}>{t.samples}</button>
      </div>
    </div>
    <div className="gallery-grid">
      {matching.map(template => <article className="gallery-card" key={template.id}>
        {template.sample
          ? <button className="gallery-cover" type="button" aria-label={`${t.preview} · ${template.name}`}
              onClick={() => { setPlayError(false); setPreviewId(template.id); }}>
              <img src={assetUrl(template.sample.posterUrl)} alt="" loading="lazy" />
              <span className="gallery-play"><Play size={18} fill="currentColor" /></span>
              <span className="gallery-time">{template.defaults.seconds} {t.seconds}</span>
            </button>
          : <div className="gallery-cover gallery-cover-placeholder"><Layers3 size={26} /><span>{t.noSample}</span></div>}
        <div className="gallery-card-copy">
          <h3>{template.name}</h3>
          <p>{template.description}</p>
          <div className="gallery-card-actions">
            <span className="gallery-tag">{template.output === 'game' ? t.game : t.video}</span>
            <button type="button" className="gallery-use" aria-label={`${t.use} · ${template.name}`} onClick={() => onUse(template)}>{t.use}</button>
          </div>
        </div>
      </article>)}
    </div>
    {!matching.length ? <p className="gallery-empty" role="status">{t.noResults}</p> : null}
  </section>;
}
