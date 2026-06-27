/** Strip quotes/control chars so sandbox-controlled names cannot inject headers. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'artifact';
}
