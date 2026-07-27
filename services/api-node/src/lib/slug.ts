import { nanoid } from 'nanoid';

export function makeSlug(prefix: string): string {
  const normalized = prefix
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'property';
  return `${normalized}-${nanoid(8).toLowerCase()}`;
}
