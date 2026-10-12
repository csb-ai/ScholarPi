import { useState } from 'react';

export function MarkdownCode({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState('');
  return <div className="markdown-code-block">
    <header><span>{language || '代码'} · 仅展示，不执行</span><button onClick={async()=>{
      try { await navigator.clipboard.writeText(code); setCopied('已复制'); }
      catch { setCopied('请选中代码后复制'); }
    }}>{copied || '复制代码'}</button></header>
    <pre><code className={language ? `language-${language}` : undefined}>{code}</code></pre>
  </div>;
}
