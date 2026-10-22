/** IME confirmation must remain an editing action, never a form submission. */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
