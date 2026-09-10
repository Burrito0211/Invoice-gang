/**
 * The seeded Taiwanese rule table, exercised against the real product strings
 * from a carrier export.
 *
 * The rules are heuristics over raw POS text, so the point of these tests is
 * not that every guess is right — it is that the ones which are *deliberately*
 * ordered stay ordered. `茶葉蛋` is a snack and must not be caught by a tea
 * rule; `酒精` is disinfectant and must not be caught as a drink. Those
 * collisions are why priority exists, and they break silently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listCategories, listItemRules, listMerchantRules } from '../src/db/queries.js';
import { matchItemRule, resolve, type RuleContext } from '../src/categorize/rules.js';
import { itemKey } from '../src/categorize/normalize.js';
import { createTestDb } from './helpers/d1.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_SQL = readFileSync(join(here, '..', 'src', 'db', 'rules-tw.sql'), 'utf8');

let db: ReturnType<typeof createTestDb>;
let ctx: RuleContext;
let categoryOf: Map<number, string>;

beforeEach(async () => {
  db = createTestDb();
  await db.exec(RULES_SQL);

  const categories = await listCategories(db);
  categoryOf = new Map(categories.map((c) => [c.id, c.key]));

  ctx = {
    overrides: new Map(),
    itemRules: await listItemRules(db),
    rules: (await listMerchantRules(db)).map((r) => ({
      match_type: r.match_type,
      pattern: r.pattern,
      category_id: r.category_id,
      priority: r.priority,
    })),
    cache: new Map(),
  };
});

afterEach(() => db.close());

/** Classify a raw description the way an import would. */
function classify(description: string, sellerName: string | null = null): string | null {
  const hit = resolve(
    { itemKey: itemKey(description), sellerBan: null, sellerName },
    ctx,
  );
  return hit === null ? null : (categoryOf.get(hit.categoryId) ?? null);
}

describe('the seed applies cleanly', () => {
  it('loads a substantial rule table', () => {
    expect(ctx.itemRules.length).toBeGreaterThan(200);
    expect(ctx.rules.length).toBeGreaterThan(40);
  });

  it('is safe to apply twice', async () => {
    const before = (await listItemRules(db)).length;
    await db.exec(RULES_SQL);
    expect((await listItemRules(db)).length).toBe(before);
  });

  it('assigns every rule a real category', async () => {
    for (const rule of ctx.itemRules) expect(categoryOf.has(rule.category_id)).toBe(true);
  });
});

describe('collisions that priority exists to resolve', () => {
  it('reads 茶葉蛋 as food, not tea', () => {
    // A generic 茶 rule would swallow this; the 茶 rules are all specific
    // compounds and 茶葉蛋 is listed at priority 10 regardless.
    expect(classify('茶葉蛋')).toBe('groceries');
  });

  it('reads 酒精 as disinfectant, not a drink', () => {
    expect(classify('酒精棉片')).toBe('health');
  });

  it('prefers the longer pattern when two could match', () => {
    // 蒸氣眼罩 → personal, and there is no bare 眼罩 rule to fight it.
    expect(classify('美舒律蒸氣眼罩漢溫舒芯系列5片-陳皮')).toBe('personal');
    // 濕巾 and 柔濕巾 both exist and agree; the specific one is consulted first.
    expect(classify('樂品純水柔濕巾20抽')).toBe('household');
  });

  it('does not let a generic 飲料 rule pre-empt a specific product', () => {
    expect(matchItemRule('運動飲料', ctx.itemRules)).toBe(
      matchItemRule('補給飲料', ctx.itemRules),
    );
    expect(classify('黑松FIN補給飲料PET975')).toBe('drinks');
  });
});

describe('real strings from a carrier export', () => {
  const cases: [string, string][] = [
    ['黑松FIN補給飲料PET975', 'drinks'],
    ['(A)*PH9.0鹼性離子水PET800', 'drinks'],
    ['可口可樂ZERO-PET600.', 'drinks'],
    ['魔爪超越能量碳酸飲料can355', 'drinks'],
    ['G)日本7PREMIUM葡萄柚風味沙瓦酒', 'drinks'],
    ['餐-大麥克MOP/外送', 'dining'],
    ['配-經典大薯', 'dining'],
    ['配-四雞塊', 'dining'],
    ['餐-無敵豬蛋', 'dining'],
    ['馬鈴薯餅', 'dining'],
    ['香脆炸雞(微辣)(TS代銷)', 'dining'],
    ['舒潔長包紙手帕10抽15入', 'household'],
    ['好奇純水嬰兒濕巾加厚型70抽-小熊維尼限定', 'household'],
    ['潘婷3 MINUTE多效護髮精華180ml', 'personal'],
    ['三多好入睡植物性膠囊30粒/盒', 'health'],
    ['(區)黃金玉米', 'groceries'],
  ];

  for (const [description, expected] of cases) {
    it(`reads ${description} as ${expected}`, () => {
      expect(classify(description)).toBe(expected);
    });
  }

  it('covers most of a real basket without a model', () => {
    const covered = cases.filter(([d]) => classify(d) !== null).length;
    expect(covered).toBe(cases.length);
  });
});

describe('merchant fallbacks', () => {
  it('catches an unrecognised item by its shop', () => {
    // No item rule knows this string; the 7-ELEVEN fallback answers.
    expect(classify('某某新商品', '統一超商股份有限公司台北市第五十三門市')).toBe('groceries');
  });

  it('never overrides an item rule', () => {
    // Bought at a convenience store, but it is plainly a drink.
    expect(classify('可口可樂ZERO-PET600.', '統一超商股份有限公司')).toBe('drinks');
    // And a charger at the same shop is not groceries.
    expect(classify('USB 充電線', '統一超商股份有限公司')).toBe('electronics');
  });

  it('leaves a genuinely unknown item at an unknown shop unresolved', () => {
    expect(classify('某某新商品', '某某商行')).toBeNull();
  });
});
