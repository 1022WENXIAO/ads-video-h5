import { useState, type RefObject } from 'react';
import { AtSign, Check, Layers3 } from 'lucide-react';
import type { VideoTemplate } from '../shared/videoTemplates';
import './templates.css';

export default function TemplateMentionInput({templates,value,onChange,inputRef,disabled,placeholder,rows,onSubmit,selectedTemplateId}:{
  templates:VideoTemplate[];value:string;onChange:(value:string)=>void;inputRef:RefObject<HTMLTextAreaElement|null>;
  disabled:boolean;placeholder:string;rows:number;onSubmit:()=>void;selectedTemplateId?:string;
}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0);
  const matching=templates.filter(t=>!query||`${t.name} ${t.id} ${t.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const current=templates.find(t=>t.id===selectedTemplateId);
  const updateQuery=(text:string,caret:number)=>{
    const mention=/(?:^|\s)[@＠]([^\s@＠，。！？,;；:：]*)$/u.exec(text.slice(0,caret));
    setOpen(Boolean(mention));setQuery(mention?.[1]||'');setActive(0);
  };
  const choose=(template:VideoTemplate)=>{
    const input=inputRef.current,start=input?.selectionStart??value.length,end=input?.selectionEnd??start;
    const before=value.slice(0,start),mention=/(?:^|\s)[@＠]([^\s@＠，。！？,;；:：]*)$/u.exec(before);
    const from=mention?start-mention[1].length-1:start;
    const prefix=value.slice(0,from),insertion=`${prefix&&!/\s$/.test(prefix)?' ':''}@${template.name} `;
    const next=prefix+insertion+value.slice(end);
    if(next.length>3000)return;
    onChange(next);setOpen(false);setQuery('');
    requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(prefix.length+insertion.length,prefix.length+insertion.length);});
  };
  return <div className="template-composer-input">
    <div className="template-toolbar"><button type="button" disabled={disabled} aria-label="选择制作模板" aria-expanded={open} aria-controls="video-template-options" onMouseDown={e=>e.preventDefault()} onClick={()=>{setOpen(v=>!v);setQuery('');setActive(0);inputRef.current?.focus();}}><AtSign size={14}/>模板</button>{current?<span><Check size={12}/>{current.name}</span>:<small>输入 @ 选择制作模板</small>}</div>
    {open?<div className="template-options" id="video-template-options" role="listbox" aria-label="制作模板">
      {matching.length?matching.map((t,index)=><button key={t.id} id={`video-template-option-${t.id}`} type="button" role="option" aria-selected={index===Math.min(active,matching.length-1)} className={index===Math.min(active,matching.length-1)?'is-active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(t)}><Layers3 size={19}/><span><strong>{t.name}</strong><small>{t.description}</small></span><span className="template-option-meta">{t.output==='game'?'交互游戏':`${t.defaults.panels}图 · ${t.defaults.seconds}秒`}</span></button>):<p>暂无匹配的模板，试试“动态图科普视频”。</p>}
      <small className="template-options-footer">更多模板正在制作中</small>
    </div>:null}
    <textarea ref={inputRef} disabled={disabled} aria-label={placeholder} placeholder={placeholder} value={value} rows={rows} maxLength={3000} enterKeyHint="enter" aria-controls={open?'video-template-options':undefined} aria-expanded={open} aria-autocomplete="list" aria-activedescendant={open&&matching.length?`video-template-option-${matching[Math.min(active,matching.length-1)].id}`:undefined}
      onChange={e=>{onChange(e.target.value);updateQuery(e.target.value,e.target.selectionStart);}}
      onClick={e=>updateQuery(e.currentTarget.value,e.currentTarget.selectionStart)}
      onKeyDown={e=>{
        if(e.nativeEvent.isComposing||e.nativeEvent.keyCode===229)return;
        if(open&&e.key==='Escape'){e.preventDefault();setOpen(false);return;}
        if(open&&matching.length&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setActive(v=>(v+(e.key==='ArrowDown'?1:-1)+matching.length)%matching.length);return;}
        if(open&&matching.length&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();choose(matching[Math.min(active,matching.length-1)]);return;}
        if(e.key==='Enter'&&!e.shiftKey&&!window.matchMedia('(pointer: coarse)').matches){e.preventDefault();onSubmit();}
      }}/>
  </div>;
}
