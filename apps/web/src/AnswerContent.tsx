import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import type { RunSnapshot, SourceRef } from '../../../packages/contracts';
import { Markdown } from './Knowledge';

export type AnswerTerm = { term: string; explanation: string; sourceRefs: SourceRef[] };
export const AnswerContent = memo(function AnswerContent({ text, run, answerId, streaming, onSourceId, onCreateTerm, onPrepare }: {
  text: string; run?: RunSnapshot; answerId: string; streaming?: boolean;
  onSourceId: (id:string)=>void;
  onCreateTerm: (term:AnswerTerm, answerId:string)=>Promise<boolean>;
  onPrepare:(text:string, refs:SourceRef[])=>void;
}) {
  const deferred=useDeferredValue(text);
  const [saved,setSaved]=useState<Record<string,boolean>>({});
  const [saving,setSaving]=useState<Record<string,boolean>>({});
  const terms=useMemo(()=>{
    if(run?.keywords?.length)return run.keywords.filter(k=>k.term.trim()&&k.explanation.trim()).slice(0,6);
    if(streaming)return [];
    // Old answers without structured keywords may still offer explicitly defined terms.
    const result:AnswerTerm[]=[];
    const regex=/\*\*([^*\n]{2,45})\*\*\s*[：:]\s*([^\n]{12,500})/g;
    for(const match of text.matchAll(regex)){
      const term=match[1].trim();if(['原文出处','总结','注意','核心贡献','一句话'].includes(term))continue;
      result.push({term,explanation:match[2].trim(),sourceRefs:[]});if(result.length===5)break;
    }
    return result;
  },[run?.keywords,text,streaming]);
  const create=useCallback(async(term:AnswerTerm)=>{
    if(saved[term.term]||saving[term.term])return;
    setSaving(values=>({...values,[term.term]:true}));
    try {if(await onCreateTerm(term,answerId))setSaved(values=>({...values,[term.term]:true}));}
    finally {setSaving(values=>({...values,[term.term]:false}));}
  },[saved,saving,onCreateTerm,answerId]);
  const createByName=useCallback((name:string)=>{const term=terms.find(t=>t.term===name);if(term)void create(term);},[terms,create]);
  return <>
    {terms.length>0 ? <section className="answer-card-suggestions" aria-label="本轮术语卡片">
      <div><b>本轮难词，顺手记住</b><span>点术语即可保存解释卡片；正文中的虚线词也可以点。</span></div>
      <div className="term-card-chips">{terms.map(term=><button key={term.term} disabled={saved[term.term]||saving[term.term]} title={term.explanation} onClick={()=>void create(term)}>{saved[term.term]?'✓ ':saving[term.term]?'正在保存… ':'＋ '}{term.term}{saved[term.term]?' · 已建卡':''}</button>)}</div>
      <button className="text-link" disabled={Object.values(saving).some(Boolean)||terms.every(t=>saved[t.term])} onClick={async()=>{for(const term of terms)await create(term);}}>一键保存本轮术语卡片</button>
    </section> : !streaming ? <div className="answer-card-nudge"><span>想留住某段理解？选中文字即可一键建卡。</span><button onClick={()=>onPrepare(text,run?.evidence||[])}>从这段讲解创建卡片</button></div> : null}
    <div className="prose"><Markdown text={streaming?deferred:text} onSourceId={onSourceId} terms={terms} onTerm={createByName}/></div>
  </>;
});
