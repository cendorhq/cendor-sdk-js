import { describe, expect, it } from 'vitest';
import { MARKER_BEGIN, MARKER_END, upsertManaged } from '../src/io.js';

describe('upsertManaged', () => {
  it('creates a lone block when there is no file', () => {
    const { content, kind } = upsertManaged(null, 'BODY');
    expect(kind).toBe('created');
    expect(content).toContain(MARKER_BEGIN);
    expect(content).toContain('BODY');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('appends after existing user content without markers', () => {
    const { content, kind } = upsertManaged('# My notes\n\nkeep me', 'BODY');
    expect(kind).toBe('appended');
    expect(content.startsWith('# My notes')).toBe(true);
    expect(content).toContain('keep me');
    expect(content).toContain(MARKER_BEGIN);
  });

  it('replaces only the managed region on re-run, preserving surrounding text', () => {
    const first = upsertManaged('TOP\n\n_footer_', 'V1').content;
    expect(first).toContain('V1');
    const second = upsertManaged(first, 'V2');
    expect(second.kind).toBe('updated');
    expect(second.content).toContain('V2');
    expect(second.content).not.toContain('V1');
    expect(second.content).toContain('TOP');
    expect(second.content).toContain('_footer_');
    // No duplicate markers.
    expect(second.content.split(MARKER_BEGIN).length - 1).toBe(1);
    expect(second.content.split(MARKER_END).length - 1).toBe(1);
  });

  it('is idempotent — same body twice yields identical content', () => {
    const once = upsertManaged('x', 'BODY').content;
    const twice = upsertManaged(once, 'BODY').content;
    expect(twice).toBe(once);
  });
});
