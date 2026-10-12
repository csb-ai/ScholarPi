import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, FileText, HelpCircle, Search, Layers, Download, UploadCloud } from 'lucide-react';
import type { Paper, RunSnapshot, StoredRunEvent } from '../../../packages/contracts';
import { Markdown } from './Knowledge';
import { api } from './api';

export type PageView = 'home' | 'workbench' | 'guide';
export function HomePage({ papers, selected, onChoose, onImport, onNavigate, onOpenKnowledge, uploading }: {
  papers: Paper[]; selected?: Paper; onChoose: (p: Paper) => void; onImport: () => void;
  onNavigate: (p: PageView) => void; uploading: boolean;
  onOpenKnowledge: (kind: 'notes' | 'cards') => void;
}) {
  return <div className="home-page">
    <section className="home-hero">
      <span className="section-kicker">论文阅读与知识工作台</span>
      <h2>读懂论文，<br />留下自己的理解。</h2>
      <p>读论文不止拿到一份总结。核对原文，把自己的解释留下来，再用正反面知识卡片回忆和复习。</p>
      <div className="home-actions">
        <button className="primary" onClick={onImport} disabled={uploading}><BookOpen size={17} />{uploading ? '正在接收文件…' : '上传论文或文件'}</button>
        <button onClick={()=>onOpenKnowledge('cards')}><Layers size={17}/>知识卡片与复习</button>
        {selected && <button onClick={() => onChoose(selected)}>继续阅读 <ArrowRight size={16} /></button>}
      </div>
      <p className="home-drop-hint"><UploadCloud size={16}/>也可以直接拖到页面任意位置，松开即导入。支持 PDF、TXT、Markdown、DOCX、PNG/JPG。</p>
      <button className="text-link" onClick={() => onNavigate('guide')}><HelpCircle size={15} />第一次使用，先看操作指南</button>
      <img className="home-poster" src="/media/scholarpi-poster.png" alt="ScholarPi：读懂论文，留下理解" />
    </section>
    <section className="home-memory-feature">
      <div><span className="section-kicker">理解一次，之后还能想起来</span><h2>把你的理解，<br/>变成会再次遇见的卡片。</h2><p>正面留问题，反面存自己的解释。先回忆再揭晓，按真实记忆安排下次复习。原文以后变了，卡片仍保留你当时确认的理解。</p><div className="home-actions"><button className="primary" onClick={()=>onOpenKnowledge('cards')}><Layers size={17}/>打开知识卡片</button><button onClick={()=>onOpenKnowledge('notes')}>我的笔记本 <ArrowRight size={16}/></button></div><small>解释独立保存 · 来源可回看 · 退出不改变复习进度</small></div>
      <div className="home-card-stack" aria-hidden="true"><div className="stack-paper stack-back"/><div className="stack-paper stack-middle"/><div className="stack-paper stack-front"><span>正面 · 先回忆</span><h3>这一段知识，<br/>你能用自己的话<br/>讲出来吗？</h3><div>想一想 → 揭晓解释 → 自评</div><footer>留住理解，而不只是收藏</footer></div></div>
    </section>
    <section className="home-section">
      <div className="section-heading"><h3>我的论文</h3><span>{papers.length} 篇已导入</span></div>
      <p className="muted">打开已导入论文，继续阅读或查看自己的已保存讲解。同一份原 PDF 再次上传时，程序会识别文件并打开已有记录。</p>
      <div className="home-library">{papers.filter(p => p.status !== 'deleted').map(p => <div className="library-entry" key={p.paperId}>
        <button onClick={() => onChoose(p)}><FileText size={20} /><span><strong>{p.title}</strong><small>{p.pageCount} 页 · {p.status === 'ready' ? '可阅读' : '查看处理进度'}</small></span><ArrowRight size={16} /></button>
        <a href={`/api/papers/${p.paperId}/pdf?revisionId=${p.revisionId}`} download={`${p.title}.pdf`}><Download size={13} /> {p.sourceFormat && p.sourceFormat !== 'pdf' ? '下载 PDF 阅读版' : '下载这份原始 PDF'}</a>
      </div>)}</div>
      {!papers.length && <p className="muted">还没有论文，从上方“上传论文 PDF”开始。</p>}
    </section>
    <section className="home-section">
      <div className="section-heading"><h3>你决定阅读怎么进行</h3></div>
      <div className="learning-flow">{[
        ['01', '上传或选论文', '文件指纹一致时，打开已有记录'],
        ['02', '选择目标与效果', '建立直觉、掌握方法或深入技术'],
        ['03', '核对并追问', '点页码看原文，查看真实运行过程'],
        ['04', '留下理解', '确认笔记和卡片，检索和复习'],
      ].map(([n, title, desc]) => <div key={n}><span>{n}</span><strong>{title}</strong><p>{desc}</p></div>)}</div>
    </section>
    <section className="home-feature-grid">
      <article><BookOpen size={19} /><h3>讲解和原文一起看</h3><p>选择希望达到的效果，Agent 按问题读取原文和图表。</p></article>
      <article><Layers size={19} /><h3>像卡片一样复习</h3><p>先看问题、翻面核对、自评记忆；不是一次展开全部答案。</p></article>
      <article><Search size={19} /><h3>记录可以再次打开</h3><p>已完成的结果来自正常运行，可以继续提问、保存和找回。</p></article>
    </section>
  </div>;
}

export function GuidePage({ onNavigate }: { onNavigate: (p: PageView) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void fetch('/guide.md').then(r => { if (!r.ok) throw Error('使用指南暂时无法加载'); return r.text(); }).then(setText).catch(e => setError(e.message)); }, []);
  return <div className="guide-page">
    <div className="guide-intro"><span className="section-kicker">从这里开始</span><h2>从真实文件，走完一次阅读。</h2>
      <p>上传 PDF 后选择目标和讲解效果。已保存结果直接打开，需要新的效果就再生成，仍然可以自由追问。</p>
      <button className="primary" onClick={() => onNavigate('home')}>返回首页选论文 <ArrowRight size={16} /></button>
    </div>
    <div className="guide-quick-map"><strong>最常用的五个操作</strong><ol>
      <li>点击“首页”或左上角 ScholarPi：回到入口。</li>
      <li>上传 PDF：同一文件按 SHA-256 打开原论文；换文件则处理新论文。</li>
      <li>选择阅读目标与讲解效果，确认问题后发送；也可打开已有讲解。</li>
      <li>点页码核对 PDF，展开“运行过程”查看实际工具、计划与事件。</li>
      <li>“记到笔记”或“加入卡片”后确认保存，继续检索和复习。</li>
    </ol></div>
    {error ? <p className="error">{error}</p> : text ? <div className="prose guide-document"><Markdown text={text} /></div> : <p className="muted">正在加载项目说明…</p>}
  </div>;
}

export function RunTrace({ runId }: { runId: string }) {
  const [data, setData] = useState<{ snapshot: RunSnapshot; events: StoredRunEvent[]; available: boolean }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (data || loading) return;
    setLoading(true);
    void api(`/runs/${runId}/trace`).then(setData).catch(e => setError(e.message)).finally(() => setLoading(false));
  };
  const downloadTrace = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.events.map(e => JSON.stringify(e)).join('\n') + '\n'], { type: 'application/x-ndjson' }));
    const a = document.createElement('a'); a.href = url; a.download = `${runId}.jsonl`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const labels: Record<string, string> = { snapshot: '读取开始', plan: '阅读计划', tool: '工具执行', evidence: '取得证据', claims: '论断复核', done: '保存完成', document_progress: '文件处理', verification: '证据核查', support_verification: '支持关系检查' };
  const phases: Record<string, string> = { queued: '等待开始', preparing: '准备材料', generating: '生成讲解', verifying: '复核证据', correcting: '有限纠正', finalizing: '整理存档' };
  const seconds = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(2)} 秒`;
  const d = data?.snapshot.diagnostics;
  return <details className="run-trace" onToggle={e => { if (e.currentTarget.open) load(); }}>
    <summary>运行过程 · 查看这次实际生成的记录</summary>
    {loading && <p>正在读取原始记录…</p>}{error && <p className="error">{error}</p>}
    {data && <>
      <p>原生成时间：{new Date(data.snapshot.createdAt).toLocaleString('zh-CN', { hour12: false })}。状态：{data.snapshot.status}；{data.events.length} 个原始事件。打开记录不会重跑模型。</p>
      {d && <section className="run-diagnostic" aria-label="运行诊断摘要">
        <div className="run-diagnostic-heading"><strong>这次阅读做了什么</strong><span>{d.finished ? '已结束' : '进行中'}{data.snapshot.stopReason ? ` · ${data.snapshot.stopReason}` : ''}</span></div>
        <div className="run-diagnostic-grid">
          <div><small>主循环 / 复核 / 纠正</small><strong>{d.models.main} / {d.models.verification} / {d.models.correction}</strong><span>模型调用尝试，分开记录</span></div>
          <div><small>学术工具 / 控制工具</small><strong>{d.tools.business} / {d.tools.control}</strong><span>主循环实际进入执行的工具</span></div>
          <div><small>后台取证与准备操作</small><strong>{d.tools.backend}</strong><span>不与主循环工具次数混算</span></div>
          <div><small>首次正文等待</small><strong>{seconds(d.firstTextMs)}</strong><span>从本轮进入队列到首次正文</span></div>
        </div>
        <div className="run-phase-list">{d.phases.map((phase, i) => <span key={i}>{phases[phase.name] ?? phase.name}<b>{seconds(phase.durationMs)}</b></span>)}</div>
        <p className="small muted">Token：输入 {d.tokens.input} · 缓存读取 {d.tokens.cacheRead} · 缓存写入 {d.tokens.cacheWrite} · 输出 {d.tokens.output}；费用未知。{d.tokens.unknownResponses > 0 && ` ${d.tokens.unknownResponses}次响应缺少可确认用量。`}</p>
        {d.limits && <p className="small muted">{d.limits.enabled ? `统一预算已启用：模型尝试最多${d.limits.models}次，准备材料至复核/纠正共享${Math.round(d.limits.timeoutMs / 1000)}秒执行时间。` : '当前使用原执行限制；调用摘要仍正常记录。'} 排队和共享扫描作业另行记录。</p>}
        {d.sharedJobId && <p className="small muted">本轮关联文档后台任务；停止阅读会退出等待，后台文档处理可继续。</p>}
        {d.cancelSettleMs !== undefined && <p className="small muted">停止后退出本轮工作：{seconds(d.cancelSettleMs)}（最终存档请求另计）。</p>}
        <details><summary>展开调用明细 · {d.calls.length}项</summary><ol className="run-call-list">{d.calls.map(call => <li key={call.callId}><span>{call.kind === 'model' ? ({ main: '主循环模型', verification: '复核模型', correction: '纠正模型' }[call.name] ?? call.name) : call.name}</span><small>{call.status} · {seconds(call.durationMs)}</small></li>)}</ol></details>
      </section>}
      {!d && <p className="small muted">历史讲解保留原始事件；分阶段摘要从本次版本开始记录。</p>}
      {data.available ? <ol className="run-timeline">{data.events.filter(e => labels[e.type]).map(e => {
        const p = e.payload as any;
        return <li key={e.seq}><time>{e.timestamp ? new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : `#${e.seq}`}</time>
          <span>{labels[e.type]}{e.type === 'tool' ? ` · ${p.name} · ${p.status}` : e.type === 'plan' ? ` · ${p.steps?.length ?? 0} 步` : ''}</span></li>;
      })}</ol> : <p>这份历史结果没有保存事件文件，不能展示完整过程。</p>}
      {data.available && <button onClick={downloadTrace} type="button">下载原始事件 JSONL</button>}
    </>}
  </details>;
}
