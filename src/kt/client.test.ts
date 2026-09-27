import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertGuid, formatCzechDate, formatCzechDecimal, parseCzechNumber, shiftCzechDate } from './client.js';

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
