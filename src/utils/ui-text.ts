/** Short dynamic UI strings follow Zotero's locale; static preference labels use Fluent. */
export function uiText(english: string, chinese: string): string {
  const locale = String((Zotero as any).locale || (globalThis as any).navigator?.language || "en");
  return /^zh(?:[-_]|$)/i.test(locale) ? chinese : english;
}

/** Shared labels keep live messages, saved messages and panel controls consistent. */
const labels = {
  send: ["Send", "发送"],
  stop: ["Stop", "停止"],
  cancel: ["Cancel", "取消"],
  copy: ["Copy", "复制"],
  copied: ["Copied!", "已复制"],
  copyFailed: ["Failed", "复制失败"],
  copyMarkdown: ["Copy as Markdown", "复制为 Markdown"],
  edit: ["Edit", "编辑"],
  history: ["History", "历史"],
  historyTitle: ["Chat History", "聊天记录"],
  newChat: ["New chat", "新建会话"],
  addImage: ["Add image", "添加图片"],
  addingImages: ["Adding images…", "正在添加图片…"],
  minimize: ["Minimize", "最小化"],
  restore: ["Restore ChatPDF", "展开 ChatPDF"],
  modelProfile: ["Model profile", "模型配置"],
  thinking: ["Thinking", "思考中"],
  thought: ["Thought", "思考过程"],
  welcome: ["Ask questions about your documents", "围绕文献提问"],
  welcomeHint: ["Drag a Zotero item into the input, or right-click it to add it to ChatPDF", "将 Zotero 条目拖入输入框，或通过右键菜单添加文献"],
  inputHint: ["Enter to send · Shift+Enter for a new line", "Enter 发送 · Shift+Enter 换行"],
  inputHelp: ["Enter or Ctrl+Enter to send; Shift+Enter for a new line", "Enter 或 Ctrl+Enter 发送；Shift+Enter 换行"],
} as const;

export function uiLabel(key: keyof typeof labels): string {
  const [english, chinese] = labels[key];
  return uiText(english, chinese);
}
