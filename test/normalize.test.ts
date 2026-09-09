/**
 * `item_key` derivation, over the shapes real POS text actually takes.
 *
 * The cache is only as good as this function: too strict and every spelling
 * variant is a fresh model call, too loose and distinct products collapse
 * into one wrong answer. These tests pin both edges.
 */
import { describe, expect, it } from 'vitest';
import { itemKey } from '../src/categorize/normalize.js';

describe('itemKey', () => {
  it('folds full-width characters to half-width', () => {
    expect(itemKey('ＣＩＴＹ　ＣＡＦＥ')).toBe(itemKey('CITY CAFE'));
  });

  it('is case insensitive', () => {
    expect(itemKey('City Cafe Latte')).toBe(itemKey('CITY CAFE LATTE'));
  });

  it('collapses runs of whitespace, including the full-width space', () => {
    expect(itemKey('茶葉蛋　　x2')).toBe('茶葉蛋 x2');
    expect(itemKey('  御飯糰\t\t鮪魚 ')).toBe('御飯糰 鮪魚');
  });

  it('strips a leading POS product code', () => {
    expect(itemKey('4710123456789 統一麵')).toBe('統一麵');
    expect(itemKey('000123456 CITY CAFE')).toBe('city cafe');
  });

  it('keeps a short number that is part of the product name', () => {
    // Five digits is not a product code, and 12345 could be the product.
    expect(itemKey('12345 果汁')).toBe('12345 果汁');
  });

  it('keeps sizes and flavors, which distinguish real products', () => {
    expect(itemKey('拿鐵 M')).not.toBe(itemKey('拿鐵 L'));
    expect(itemKey('可樂 500ml')).not.toBe(itemKey('可樂 1000ml'));
  });

  it('does not merge distinct products that merely look similar', () => {
    expect(itemKey('美式咖啡')).not.toBe(itemKey('美式咖啡豆'));
  });

  it('is stable — the same input always gives the same key', () => {
    const messy = '  ４７１０９９９９９９９９９　　特濃拿鐵　Ｍ ';
    expect(itemKey(messy)).toBe(itemKey(messy));
    expect(itemKey(messy)).toBe('特濃拿鐵 m');
  });
});
