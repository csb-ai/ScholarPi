type Node = { type: string; value?: string; url?: string; children?: Node[] };
export default function remarkTerms(options: { terms: string[] }) {
  return (tree: Node) => {
    const names=[...new Set(options.terms.map(s=>s.trim()).filter(Boolean))].sort((a,b)=>b.length-a.length);
    if(!names.length)return;
    const expression=new RegExp(names.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
    const seen=new Set<string>();
    function walk(node: Node) {
      if(['code','inlineCode','math','inlineMath','link','linkReference','definition','html'].includes(node.type)||!node.children)return;
      const next: Node[]=[];
      for(const child of node.children) {
        if(child.type!=='text'||!child.value){walk(child);next.push(child);continue;}
        const value=child.value;let cursor=0;expression.lastIndex=0;let match:RegExpExecArray|null;
        while((match=expression.exec(value))) {
          const term=match[0], start=match.index, end=start+term.length;
          if(seen.has(term)||(/^[A-Za-z0-9]/.test(term)&&/[A-Za-z0-9_]/.test(value[start-1]||''))||(/[A-Za-z0-9]$/.test(term)&&/[A-Za-z0-9_]/.test(value[end]||'')))continue;
          if(start>cursor)next.push({type:'text',value:value.slice(cursor,start)});
          next.push({type:'link',url:'scholarpi-term:'+encodeURIComponent(term),children:[{type:'text',value:term}]});
          seen.add(term);cursor=end;
        }
        if(cursor<value.length)next.push({type:'text',value:value.slice(cursor)});
      }
      node.children=next;
    }
    walk(tree);
  };
}
