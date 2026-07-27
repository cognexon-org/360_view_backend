import { describe, expect, it } from 'vitest';
import { makeSlug } from '../slug.js';

 describe('makeSlug', () => {
  it('creates a URL-safe unique slug', () => {
    const slug = makeSlug('Living Room Tour');
    expect(slug).toMatch(/^living-room-tour-[a-z0-9_-]{8}$/);
  });
});
