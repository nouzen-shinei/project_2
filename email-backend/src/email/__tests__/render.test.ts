import { describe, it, expect } from 'vitest';
import { renderEmail } from '../render.js';

describe('renderEmail', () => {
  it('renders bilingual with labels', () => {
    const out = renderEmail({
      kind: 'custom',
      studentName: 'Alice',
      messages: { en: 'Hello', hi: 'नमस्ते' },
      amount: undefined,
      dueDate: undefined,
      order: 'english-first',
      showLabels: true
    });
    expect(out.subject).toContain('Alice');
    expect(out.html).toContain('Hello');
    expect(out.html).toContain('नमस्ते');
    expect(out.text).toMatch(/EN:/);
    expect(out.text).toMatch(/HI:/);
  });

  it('handles fee reminder specifics', () => {
    const out = renderEmail({
      kind: 'fee',
      studentName: 'Bob',
      amount: '2500',
      dueDate: '2025-09-01',
      messages: { en: 'Pay soon' },
      order: 'english-first'
    });
    expect(out.subject).toMatch(/Fee Reminder/);
    expect(out.html).toContain('Amount Due');
    expect(out.text).toContain('Fee Reminder');
  });
});
