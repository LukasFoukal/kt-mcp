import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertGuid, formatCzechDate, formatCzechDecimal, parseCzechNumber, parseDiarySummary, shiftCzechDate } from './client.js';

test('parses Czech decimal commas', () => {
  assert.equal(parseCzechNumber('20,43'), 20.43);
  assert.equal(parseCzechNumber('0,56'), 0.56);
  assert.equal(parseCzechNumber('249'), 249);
});

test('strips the thousands separator, including the non-breaking space the site emits', () => {
  assert.equal(parseCzechNumber('1 043'), 1043);
  assert.equal(parseCzechNumber('1 043'), 1043);
  assert.equal(parseCzechNumber('1 021,35'), 1021.35);
});

test('passes numbers through and rejects non-finite ones', () => {
  assert.equal(parseCzechNumber(17), 17);
  assert.equal(parseCzechNumber(Number.NaN), null);
  assert.equal(parseCzechNumber(Number.POSITIVE_INFINITY), null);
});

test('returns null rather than a misleading zero for absent values', () => {
  assert.equal(parseCzechNumber(null), null);
  assert.equal(parseCzechNumber(undefined), null);
  assert.equal(parseCzechNumber(''), null);
  assert.equal(parseCzechNumber('   '), null);
  assert.equal(parseCzechNumber('n/a'), null);
});

test('formats dates the way the site expects', () => {
  assert.equal(formatCzechDate(new Date(2026, 7, 2)), '02.08.2026');
  assert.equal(formatCzechDate(new Date(2026, 11, 25)), '25.12.2026');
});

test('formats decimals with a comma, the way the weight form expects', () => {
  assert.equal(formatCzechDecimal(82.4), '82,4');
  assert.equal(formatCzechDecimal(80), '80');
  assert.equal(parseCzechNumber(formatCzechDecimal(97.35)), 97.35);
});

test('shifts dates across month and year boundaries', () => {
  assert.equal(shiftCzechDate('01.03.2026', -1), '28.02.2026');
  assert.equal(shiftCzechDate('31.12.2026', 1), '01.01.2027');
  assert.equal(shiftCzechDate('27.09.2026', -6), '21.09.2026');
});

test('accepts a single guid and refuses anything that could widen a path', () => {
  assert.equal(assertGuid('765a39f27286475fa45ec95520ca7287', 'entry'), '765a39f27286475fa45ec95520ca7287');
  assert.equal(assertGuid('6', 'meal'), '6');
  assert.throws(() => assertGuid('a1,b2', 'entry'));
  assert.throws(() => assertGuid('../user', 'entry'));
  assert.throws(() => assertGuid('', 'entry'));
});

// Shape of /user/diary/summary/{date}/get as seen by kryvel/kalorka and
// tomasvotava/kaloricketabulky, which both read goals from this endpoint.
const diarySummary = {
  items: [
    { code: 'total', unit: 'kcal', actual: '530', goal: '1 924', percent: 28, actualValue: 0.0 },
    { title: 'Pitný režim', code: null, unit: 'l', actual: '0,25', goal: '2,95', percent: 8 },
    { title: 'Cílová hmotnost', code: null, unit: 'kg', actual: '73,8', goal: '0', percent: null },
  ],
  itemsDynamic: [
    [
      { code: 'protein', title: 'Bílkoviny', unit: 'g', actual: '24', goal: '145', percent: 16, actualValue: 24.04 },
      { code: 'carbohydrate', title: 'Sacharidy', unit: 'g', actual: '49', goal: '183', percent: 26, actualValue: 49.2 },
      { code: 'fat', title: 'Tuky', unit: 'g', actual: '23', goal: '67,3', percent: 34, actualValue: 23 },
      { code: 'fiber', title: 'Vláknina', unit: 'g', actual: '0', goal: '30', percent: 0, actualValue: 0 },
    ],
    [{ code: 'sugar', title: 'Cukry', unit: 'g', actual: '61,5', goal: '50', percent: 123 }],
  ],
  foodstuffEnergyTotal: 530,
  activityEnergyTotal: 120,
  balance: { target: '1 924' },
};

test('reads the goal of every tracked nutrient, not just energy', () => {
  const t = parseDiarySummary('01.10.2026', diarySummary);
  assert.equal(t.energy, 530);
  assert.equal(t.energyTarget, 1924);
  assert.deepEqual(t.nutrients.map(n => n.code), ['protein', 'carbohydrate', 'fat', 'fiber', 'sugar']);
  assert.deepEqual(t.nutrients[0], {
    code: 'protein', title: 'Bílkoviny', unit: 'g', actual: 24, goal: 145, remaining: 121, percent: 16,
  });
  assert.equal(t.nutrients[2]?.goal, 67.3);
  assert.equal(t.protein, 24);
  assert.equal(t.carbs, 49.2);
});

test('falls back to the display value when actualValue is missing, and goes negative when over', () => {
  const sugar = parseDiarySummary('01.10.2026', diarySummary).nutrients.find(n => n.code === 'sugar');
  assert.equal(sugar?.actual, 61.5);
  assert.equal(sugar?.remaining, -11.5);
});

test('reads drink and weight goals, treating a zero weight goal as unset', () => {
  const t = parseDiarySummary('01.10.2026', diarySummary);
  assert.equal(t.drinkLitres, 0.25);
  assert.equal(t.drinkTargetLitres, 2.95);
  assert.equal(t.weightKg, 73.8);
  assert.equal(t.weightTargetKg, null);
});

test('survives an empty summary without inventing values', () => {
  const t = parseDiarySummary('01.10.2026', {});
  assert.deepEqual(t.nutrients, []);
  assert.equal(t.energyTarget, null);
  assert.equal(t.protein, null);
});
