import { useRef, useState, type RefObject } from 'react';
import { AtSign, ArrowLeft, Layers3, Play, X } from 'lucide-react';
import { templateMentions, withoutTemplateMentions, type VideoTemplate } from '../shared/videoTemplates';
import './templates.css';

const mentionAtCaret = /(?:^|\s)[@＠]([^\s@＠，。！？,;；:：]*)$/u;
const assetPath = (url: string) => import.meta.env.BASE_URL.replace(/\/$/, '') + url;

export default function TemplateMentionInput({ templates, value, onChange, inputRef, disabled, placeholder, rows, onSubmit }: {
  templates: VideoTemplate[];
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  placeholder: string;
  rows: number;
  onSubmit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [previewId, setPreviewId] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const queryText = query.trim().toLocaleLowerCase();
  const matching = templates.filter(t => `${t.name} ${t.id} ${t.description}`.toLocaleLowerCase().includes(queryText));
  const preview = templates.find(t => t.id === previewId);
  const mentioned = templateMentions(value).map(mention => templates.find(t => t.id === mention.name || t.name === mention.name));
  const current = mentioned[0];

  function close() {
    setOpen(false);
    setPreviewId(undefined);
  }

  function updateQuery(text: string, caret: number) {
    const mention = mentionAtCaret.exec(text.slice(0, caret));
    setOpen(Boolean(mention));
    setQuery(mention?.[1] || '');
    setActive(0);
    setPreviewId(undefined);
  }

  function choose(template: VideoTemplate) {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const partial = mentionAtCaret.exec(value.slice(0, cursor));
    const raw = partial ? value.slice(0, cursor - partial[1].length - 1) + value.slice(cursor) : value;
    const next = `@${template.name} ${withoutTemplateMentions(raw, templates)}`;
    if (next.length > 3000) return;
    onChange(next);
    close();
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.length, next.length);
    });
  }

  function keyboard(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (open && event.key === 'Escape') {
      event.preventDefault();
      if (preview) setPreviewId(undefined);
      else close();
      inputRef.current?.focus();
      return;
    }
    if (open && !preview && matching.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      setActive(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + matching.length) % matching.length);
      return;
    }
    if (open && !preview && matching.length && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      choose(matching[Math.min(active, matching.length - 1)]);
    }
  }

  return <div className="template-composer-input">
    <div className="template-toolbar">
      <button type="button" disabled={disabled} aria-label="选择制作模板" aria-expanded={open}
        aria-controls="video-template-options" onClick={() => {
          if (open) { close(); return; }
          setOpen(true);
          setQuery('');
          setActive(0);
          requestAnimationFrame(() => searchRef.current?.focus());
        }}><AtSign size={14}/>模板</button>
      {current ? <span className="template-chip">
        <span>已选 {current.name}</span>
        <button type="button" aria-label="移除制作模板" disabled={disabled}
          onClick={() => { onChange(withoutTemplateMentions(value, templates)); close(); inputRef.current?.focus(); }}><X size={13}/></button>
      </span> : <small>未启用模板</small>}
    </div>
    {open ? <div className="template-options" id="video-template-options" role="region" aria-label="制作模板">
      {preview?.sample ? <div className="template-sample">
        <div className="template-sample-header">
          <button type="button" onClick={() => setPreviewId(undefined)}><ArrowLeft size={15}/>模板列表</button>
          <button type="button" className="template-use" disabled={disabled} onClick={() => choose(preview)}>使用此模板</button>
        </div>
        <video key={preview.id} controls playsInline preload="metadata" aria-label={preview.sample.title}
          src={assetPath(preview.sample.videoUrl)} poster={assetPath(preview.sample.posterUrl)}/>
        <strong>{preview.sample.title}</strong>
        <small>轻剪样片 · {preview.defaults.seconds} 秒 · {preview.description}</small>
        <div className="template-sample-sources">
          <a href={preview.sample.source.url} target="_blank" rel="noreferrer">原作 {preview.sample.source.author}</a>
          <a href={preview.sample.source.galleryUrl} target="_blank" rel="noreferrer">查看合集示例</a>
        </div>
      </div> : <>
        <input ref={searchRef} type="search" className="template-search" aria-label="搜索模板" placeholder="搜索模板"
          value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={keyboard}/>
        {matching.length ? matching.map((template, index) => <div key={template.id}
          className={index === Math.min(active, matching.length - 1) ? 'template-option is-active' : 'template-option'}>
          <button type="button" disabled={disabled} onClick={() => choose(template)} aria-label={`使用${template.name}`}>
            <Layers3 size={18}/>
            <span><strong>{template.name}</strong><small>{template.description}</small></span>
          </button>
          {template.sample ? <button type="button" className="template-watch"
            aria-label={`预览${template.name}`} onClick={() => setPreviewId(template.id)}><Play size={13}/>样片</button> : null}
        </div>) : <p>暂无匹配的模板。</p>}
      </>}
    </div> : null}
    <textarea ref={inputRef} disabled={disabled} aria-label={placeholder} placeholder={placeholder} value={value}
      rows={rows} maxLength={3000} enterKeyHint="enter"
      onChange={e => { onChange(e.target.value); updateQuery(e.target.value, e.target.selectionStart); }}
      onClick={e => updateQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
      onKeyDown={e => {
        keyboard(e);
        if (e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
          e.preventDefault();
          onSubmit();
        }
      }}/>
  </div>;
}
