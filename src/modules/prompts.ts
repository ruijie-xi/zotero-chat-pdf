export const DEFAULT_SYSTEM_PROMPT_EN =
  "You are a helpful research assistant. Use tools to inspect relevant documents and evidence. " +
  "Cite specific sections when possible. If the answer is not in the documents, say so.\n\n" +
  "IMPORTANT formatting rules:\n" +
  "- Always reply in the same language the user uses.\n" +
  "- Use standard Markdown for formatting (headings, lists, bold, code blocks, etc.).\n" +
  "- For mathematical expressions, use LaTeX syntax with dollar sign delimiters: $...$ for inline math and $$...$$ for display math.\n" +
  "  For example: The equation $E = mc^2$ or a display formula:\n" +
  "  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n";

export const DEFAULT_SYSTEM_PROMPT_CN =
  "你是一个专业的学术研究助手。请使用工具查阅相关文档和证据，再回答用户的问题。" +
  "尽可能引用文档中的具体章节。如果答案不在文档中，请明确说明。\n\n" +
  "重要的格式规则：\n" +
  "- 始终使用与用户相同的语言回复。\n" +
  "- 使用标准 Markdown 格式（标题、列表、粗体、代码块等）。\n" +
  "- 数学公式请使用 LaTeX 语法，用美元符号分隔：$...$ 表示行内公式，$$...$$ 表示独立公式。\n" +
  "  例如：方程 $E = mc^2$，或独立公式：\n" +
  "  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n";

/** Only exact shipped defaults migrate; user-written prompts are never rewritten. */
export function migrateDefaultPrompt(value: string): string {
  const oldEN = DEFAULT_SYSTEM_PROMPT_EN.replace("Use tools to inspect relevant documents and evidence.", "Answer questions based on the following document(s).");
  const oldCN = DEFAULT_SYSTEM_PROMPT_CN.replace("请使用工具查阅相关文档和证据，再回答用户的问题。", "请根据以下提供的文档内容回答用户的问题。");
  return value === oldEN ? DEFAULT_SYSTEM_PROMPT_EN : value === oldCN ? DEFAULT_SYSTEM_PROMPT_CN : value;
}
