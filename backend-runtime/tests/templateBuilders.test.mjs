import assert from 'assert';
import { buildFeeReminderTemplate, buildCustomMessageTemplate } from '../dist/templateBuilders.js';

const feeEn = buildFeeReminderTemplate({ to:'x', studentName:'Stu', amount:2500, dueDate:'2025-09-01', selectedLanguage:'english' });
assert.strictEqual(feeEn.parameters.length, 8, 'English fee template param count');
const feeBiEnFirst = buildFeeReminderTemplate({ to:'x', studentName:'Stu', amount:2500, dueDate:'2025-09-01', selectedLanguage:'both', languageOrder:'english-first' });
const feeBiHiFirst = buildFeeReminderTemplate({ to:'x', studentName:'Stu', amount:2500, dueDate:'2025-09-01', selectedLanguage:'both', languageOrder:'hindi-first' });
assert.strictEqual(feeBiEnFirst.parameters.length, 16, 'Bilingual param count (two 8-length blocks)');
assert.notDeepStrictEqual(feeBiEnFirst.parameters.slice(0,8), feeBiHiFirst.parameters.slice(0,8), 'Order difference expected');

const customEn = buildCustomMessageTemplate({ to:'x', message:'Hello', selectedLanguage:'english' });
assert.strictEqual(customEn.parameters.length, 3, 'Custom english param count');
const customBi = buildCustomMessageTemplate({ to:'x', message:'Hello', englishMessage:'Hello', hindiMessage:'Namaste', selectedLanguage:'both', languageOrder:'hindi-first' });
assert.strictEqual(customBi.parameters.length, 6, 'Custom bilingual param count');
console.log('templateBuilders.test ok');