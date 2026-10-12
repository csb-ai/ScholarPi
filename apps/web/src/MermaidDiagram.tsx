import { useEffect, useId, useRef, useState } from 'react';

type MermaidRuntime = {
  initialize: (options: Record<string, unknown>) => void;
  mermaidAPI: { render: (id: string, code: string, done: (svg: string) => void, container: HTMLElement) => void };
};
let loader: Promise<MermaidRuntime> | undefined;
let rendering: Promise<unknown> = Promise.resolve();
function loadMermaid() {
  return loader ??= new Promise<MermaidRuntime>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/mermaid-9.1.2.min.js';
    script.async = true;
    script.onload = () => {
      const runtime = (window as unknown as { mermaid?: MermaidRuntime }).mermaid;
      if (!runtime) { loader = undefined; reject(new Error('流程图组件未加载')); return; }
      runtime.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'system-ui, sans-serif' });
      resolve(runtime);
    };
    script.onerror = () => { script.remove(); loader = undefined; reject(new Error('流程图加载失败，请刷新页面重试')); };
    document.head.appendChild(script);
  });
}

export function MermaidDiagram({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    setError('');
    if (target.current) target.current.innerHTML = '';
    const task = async () => {
      if (!active) return;
      const runtime = await loadMermaid();
      if (!active) return;
      const staging = document.createElement('div');
      staging.style.cssText = 'position:absolute;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
      document.body.appendChild(staging);
      try {
        await new Promise<void>((resolve, reject) => {
          try {
            runtime.mermaidAPI.render(`scholarpi-diagram-${id}`, code, (svg) => {
              if (active && target.current) { target.current.innerHTML = svg; setReady(true); }
              resolve();
            }, staging);
          } catch (e) { reject(e); }
        });
      } finally { staging.remove(); }
    };
    // Mermaid 9 uses temporary DOM ids: render diagrams in sequence.
    rendering = rendering.catch(() => {}).then(task).catch((e) => {
      if (active) setError((e as Error).message || '流程图暂时无法显示');
    });
    return () => { active = false; };
  }, [code, id]);
  return <figure className="mermaid-diagram">
    {!ready && !error && <p className="muted" role="status">正在绘制流程图…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div ref={target} className="mermaid-canvas" aria-label="系统流程图" />
    <details><summary>查看流程图代码</summary><pre><code>{code}</code></pre></details>
  </figure>;
}
