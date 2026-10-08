export const readingEffects = [
  { id: 'simple', label: '建立直觉', description: '少用术语，多用类比，先弄懂论文在解决什么问题。' },
  { id: 'standard', label: '掌握方法', description: '解释关键步骤、专业名词和适用边界，读完能复述方法。' },
  { id: 'technical', label: '深入技术', description: '结合原图、公式和实验条件，核对机制与关键细节。' },
] as const;
export const readingDirections = [
  { id: 'quick', label: '整体理解', description: '从问题、贡献和局限建立论文全貌。' },
  { id: 'method', label: '方法机制', description: '把输入、步骤、输出和关键设计拆开讲。' },
  { id: 'figure_equation', label: '图表与公式', description: '读取原页，解释图中流程、变量和对照条件。' },
] as const;
export function readingQuestion(action: string) {
  return ({
    quick: '请讲解这篇论文解决什么问题、核心贡献和适用边界，并给出可调整的阅读路线。',
    method: '请讲解这篇论文核心方法的输入、处理步骤和输出，说明关键设计的作用与限制，并给出原文出处。',
    figure_equation: '请读取这篇论文物理第2页 Figure 1 的原图，逐步解释图中流程和关键区别，并给出可核对的原页出处。',
  } as Record<string, string>)[action] ?? '';
}
