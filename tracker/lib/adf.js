export function textToAdf(text) {
  const paragraphs = String(text ?? '').split(/\n{2,}/).map(chunk => chunk.trim()).filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map(chunk => ({
      type: 'paragraph',
      content: chunk.split('\n').flatMap((line, index) => (
        index === 0 ? [{ type: 'text', text: line }] : [{ type: 'hardBreak' }, { type: 'text', text: line }]
      ))
    }))
  };
}

export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const children = Array.isArray(node.content) ? node.content : [];
  const separator = node.type === 'doc' || node.type === 'bulletList' || node.type === 'orderedList' ? '\n\n' : '';
  return children.map(adfToText).join(separator);
}

export function normalizeRichText(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return textToAdf(value);
  if (typeof value === 'object' && value.type === 'doc') return value;
  throw new TypeError('Rich text must be a string or an Atlassian Document Format document.');
}
