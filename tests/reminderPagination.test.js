const { reminderHistoryService } = require('../services/reminderHistoryService');

describe('Reminder pagination helper', () => {
  it('returns hasMore=true and lastDocument when docs > pageSize', () => {
    const docs = [];
    for (let i = 0; i < 6; i++) {
      docs.push({ id: `doc-${i}`, data: () => ({ studentName: `Student ${i}`, status: i % 2 === 0 ? 'success' : 'failed' }) });
    }

    const result = reminderHistoryService.processDocsForPagination(docs, 5);
    expect(result.hasMore).toBe(true);
    expect(result.reminders.length).toBe(5);
    expect(result.lastDocument.id).toBe('doc-4');
  });

  it('returns hasMore=false and includes all docs when docs <= pageSize', () => {
    const docs = [];
    for (let i = 0; i < 3; i++) {
      docs.push({ id: `doc-${i}`, data: () => ({ studentName: `Student ${i}`, status: 'pending' }) });
    }

    const result = reminderHistoryService.processDocsForPagination(docs, 5);
    expect(result.hasMore).toBe(false);
    expect(result.reminders.length).toBe(3);
    expect(result.lastDocument.id).toBe('doc-2');
  });
});
