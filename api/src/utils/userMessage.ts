// Text from outside (a model, a CLI) shown to a user: no control characters or terminal escape
// codes, whitespace collapsed, and short enough to read.
const MAX_MESSAGE_CHARS = 500;

export function toUserMessage(text: string): string {
  const clean = text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS - 1)}…` : clean;
}
