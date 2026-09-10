-- Item and merchant rules for a Taiwanese basket.
--
--   npx wrangler d1 execute invoice-gang --remote --file=./src/db/rules-tw.sql
--
-- Safe to re-run: everything is INSERT OR IGNORE keyed on the pattern, so
-- applying it twice changes nothing and it will not overwrite a rule you have
-- since edited by hand.
--
-- HOW THIS RESOLVES
--
--   your correction  →  item rule  →  merchant rule  →  unclassified
--
-- Item rules match a substring of the normalized item_key (NFKC, lowercased,
-- whitespace collapsed), so patterns here are written in that form. Merchant
-- rules only ever catch what no item rule recognised, which is why a
-- convenience store can have one at all.
--
-- PRIORITY (lower wins, then longer pattern wins)
--
--    10  unambiguous, and needed early to beat a broader rule
--    50  ordinary specific product words
--   100  general words that could appear inside a longer product name
--   200  merchant fallbacks
--
-- These are heuristics over raw POS text, and some will be wrong. That is
-- what the correction loop is for: clicking a category writes an override
-- that outranks every rule here, permanently and for every future purchase of
-- the same product.
--
-- Written as plain VALUES rows rather than a compound SELECT: D1 rejects a
-- UNION ALL chain of this length with "too many terms in compound SELECT".

-- ================================================= DRINKS 飲料 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('拿鐵', (SELECT id FROM category WHERE key = 'drinks'), 10, 'latte'),
  ('美式', (SELECT id FROM category WHERE key = 'drinks'), 10, 'americano'),
  ('卡布', (SELECT id FROM category WHERE key = 'drinks'), 10, 'cappuccino'),
  ('摩卡', (SELECT id FROM category WHERE key = 'drinks'), 10, 'mocha'),
  ('咖啡', (SELECT id FROM category WHERE key = 'drinks'), 50, 'coffee'),
  ('coffee', (SELECT id FROM category WHERE key = 'drinks'), 50, NULL),
  ('latte', (SELECT id FROM category WHERE key = 'drinks'), 50, NULL),
  ('city cafe', (SELECT id FROM category WHERE key = 'drinks'), 10, '7-ELEVEN coffee counter'),
  ('紅茶', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('綠茶', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('奶茶', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('烏龍', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('青茶', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('麥茶', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('茶飲', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('豆漿', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('可樂', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('cola', (SELECT id FROM category WHERE key = 'drinks'), 50, NULL),
  ('雪碧', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('汽水', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('沙士', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('蘇打', (SELECT id FROM category WHERE key = 'drinks'), 50, NULL),
  ('果汁', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('柳橙汁', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('礦泉水', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('離子水', (SELECT id FROM category WHERE key = 'drinks'), 10, 'alkaline ionised water'),
  ('蒸餾水', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('氣泡水', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('運動飲料', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('能量飲料', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL);

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('補給飲料', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('飲料', (SELECT id FROM category WHERE key = 'drinks'), 100, 'catch-all, after the specific ones'),
  ('舒跑', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('寶礦力', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('魔爪', (SELECT id FROM category WHERE key = 'drinks'), 10, 'Monster'),
  ('黑松', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('啤酒', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('beer', (SELECT id FROM category WHERE key = 'drinks'), 50, NULL),
  ('沙瓦', (SELECT id FROM category WHERE key = 'drinks'), 10, 'chuhai / sour'),
  ('調酒', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('清酒', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('威士忌', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL),
  ('高粱', (SELECT id FROM category WHERE key = 'drinks'), 10, NULL);

-- ================================================= DINING 餐飲 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('便當', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('御飯糰', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('飯糰', (SELECT id FROM category WHERE key = 'dining'), 50, NULL),
  ('三明治', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('漢堡', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('大麥克', (SELECT id FROM category WHERE key = 'dining'), 10, 'Big Mac'),
  ('麥克雞塊', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('雞塊', (SELECT id FROM category WHERE key = 'dining'), 50, NULL),
  ('薯條', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('薯餅', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('大薯', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('中薯', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('小薯', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('滿福堡', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('豬蛋', (SELECT id FROM category WHERE key = 'dining'), 50, 'McDonald''s breakfast muffin'),
  ('炸雞', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('鹹酥雞', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('關東煮', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('熱狗', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('牛肉麵', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('拉麵', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('義大利麵', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('水餃', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('滷味', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('壽司', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('丼飯', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('咖哩', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('披薩', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('pizza', (SELECT id FROM category WHERE key = 'dining'), 50, NULL),
  ('套餐', (SELECT id FROM category WHERE key = 'dining'), 50, NULL);

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('餐盒', (SELECT id FROM category WHERE key = 'dining'), 50, NULL),
  ('早餐', (SELECT id FROM category WHERE key = 'dining'), 50, NULL),
  ('蛋餅', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('包子', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('燒餅', (SELECT id FROM category WHERE key = 'dining'), 10, NULL),
  ('油條', (SELECT id FROM category WHERE key = 'dining'), 10, NULL);

-- ============================================== GROCERIES 雜貨 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('茶葉蛋', (SELECT id FROM category WHERE key = 'groceries'), 10, 'before any 茶 rule'),
  ('雞蛋', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('鮮奶', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('牛奶', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('優酪乳', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('優格', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('起司', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('泡麵', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('科學麵', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('餅乾', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('洋芋片', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('巧克力', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('口香糖', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('軟糖', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('麵包', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('吐司', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('蛋糕', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('布丁', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('冰淇淋', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('燕麥', (SELECT id FROM category WHERE key = 'groceries'), 50, 'oat products, drink or flake'),
  ('玉米', (SELECT id FROM category WHERE key = 'groceries'), 50, NULL),
  ('水果', (SELECT id FROM category WHERE key = 'groceries'), 50, NULL),
  ('香蕉', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('蘋果', (SELECT id FROM category WHERE key = 'groceries'), 50, 'careful: also a brand name'),
  ('醬油', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('沙拉油', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('橄欖油', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('白米', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('麵粉', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL),
  ('砂糖', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL);

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('罐頭', (SELECT id FROM category WHERE key = 'groceries'), 10, NULL);

-- ============================================== HOUSEHOLD 日用 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('衛生紙', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('紙手帕', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('面紙', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('紙巾', (SELECT id FROM category WHERE key = 'household'), 50, NULL),
  ('濕紙巾', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('柔濕巾', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('濕巾', (SELECT id FROM category WHERE key = 'household'), 50, NULL),
  ('洗衣', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('洗碗', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('柔軟精', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('漂白', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('清潔劑', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('垃圾袋', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('保鮮膜', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('夾鏈袋', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('鋁箔', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('菜瓜布', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('抹布', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('拖把', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('掃把', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('燈泡', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('購物袋', (SELECT id FROM category WHERE key = 'household'), 10, NULL),
  ('塑膠袋', (SELECT id FROM category WHERE key = 'household'), 10, NULL);

-- =============================================== PERSONAL 個人 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('洗髮', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('潤髮', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('護髮', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('沐浴', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('香皂', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('肥皂', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('洗手乳', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('洗面乳', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('牙膏', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('牙刷', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('牙線', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('漱口水', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('刮鬍', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('除毛', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('體香', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('止汗', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('乳液', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('面膜', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('精華液', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('化妝水', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('卸妝', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('防曬', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('護唇', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('護手霜', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('蒸氣眼罩', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('衛生棉', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('護墊', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('棉花棒', (SELECT id FROM category WHERE key = 'personal'), 10, NULL),
  ('指甲', (SELECT id FROM category WHERE key = 'personal'), 50, NULL);

-- ================================================= HEALTH 保健 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('口罩', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('酒精', (SELECT id FROM category WHERE key = 'health'), 10, 'disinfectant, not a drink'),
  ('消毒', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('ok繃', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('繃帶', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('紗布', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('維他命', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('維生素', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('膠囊', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('益生菌', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('葉黃素', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('魚油', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('膠原', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('鈣片', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('保健食品', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('感冒', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('止痛', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('胃藥', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('藥膏', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('體溫計', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('血壓', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('隱形眼鏡', (SELECT id FROM category WHERE key = 'health'), 10, NULL),
  ('藥水', (SELECT id FROM category WHERE key = 'health'), 50, NULL);

-- ============================================== TRANSPORT 交通 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('加油', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('無鉛', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('柴油', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('汽油', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('悠遊卡', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('一卡通', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('儲值', (SELECT id FROM category WHERE key = 'transport'), 50, NULL),
  ('停車', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('車票', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('高鐵', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('台鐵', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('捷運', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('客運', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('計程車', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('機油', (SELECT id FROM category WHERE key = 'transport'), 10, NULL),
  ('輪胎', (SELECT id FROM category WHERE key = 'transport'), 10, NULL);

-- ============================================ ELECTRONICS 3C ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('充電線', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('傳輸線', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('充電器', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('行動電源', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('type-c', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('usb', (SELECT id FROM category WHERE key = 'electronics'), 50, NULL),
  ('耳機', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('滑鼠', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('鍵盤', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('記憶卡', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('隨身碟', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('電池', (SELECT id FROM category WHERE key = 'electronics'), 50, NULL),
  ('手機殼', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL),
  ('保護貼', (SELECT id FROM category WHERE key = 'electronics'), 10, NULL);

-- =============================================== CLOTHING 服飾 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('襯衫', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('t恤', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('外套', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('褲子', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('牛仔褲', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('裙子', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('襪子', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('內衣', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('內褲', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('球鞋', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('拖鞋', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL),
  ('帽子', (SELECT id FROM category WHERE key = 'clothing'), 10, NULL);

-- ========================================== ENTERTAINMENT 娛樂 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('電影票', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('遊戲點數', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('遊戲', (SELECT id FROM category WHERE key = 'entertainment'), 100, NULL),
  ('玩具', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('公仔', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('扭蛋', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('門票', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('netflix', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('spotify', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL),
  ('steam', (SELECT id FROM category WHERE key = 'entertainment'), 10, NULL);

-- ============================================== EDUCATION 書籍 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('筆記本', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('原子筆', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('鉛筆', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('螢光筆', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('橡皮擦', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('資料夾', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('雜誌', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('講義', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('參考書', (SELECT id FROM category WHERE key = 'education'), 10, NULL),
  ('文具', (SELECT id FROM category WHERE key = 'education'), 50, NULL);

-- =============================================== SERVICES 服務 ==

INSERT OR IGNORE INTO item_rule (pattern, category_id, priority, note) VALUES
  ('運費', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('手續費', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('服務費', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('代收', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('代購', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('影印', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('列印', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('掛號', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('郵資', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('乾洗', (SELECT id FROM category WHERE key = 'services'), 10, NULL),
  ('剪髮', (SELECT id FROM category WHERE key = 'services'), 10, NULL);

-- ================================================== MERCHANT FALLBACKS 商家 ==
--
-- These only catch what no item rule recognised. A convenience store sells
-- drinks, meals and groceries, so its fallback is a guess — but a guess made
-- only about items nothing else could identify.

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '統一超商', (SELECT id FROM category WHERE key = 'groceries'), 200, '7-ELEVEN'),
  ('name_contains', '全家便利', (SELECT id FROM category WHERE key = 'groceries'), 200, 'FamilyMart'),
  ('name_contains', '萊爾富', (SELECT id FROM category WHERE key = 'groceries'), 200, 'Hi-Life'),
  ('name_contains', 'ok便利', (SELECT id FROM category WHERE key = 'groceries'), 200, 'OK Mart'),
  ('name_contains', '全聯', (SELECT id FROM category WHERE key = 'groceries'), 200, 'PX Mart'),
  ('name_contains', '家樂福', (SELECT id FROM category WHERE key = 'groceries'), 200, 'Carrefour'),
  ('name_contains', '大潤發', (SELECT id FROM category WHERE key = 'groceries'), 200, 'RT-Mart'),
  ('name_contains', '好市多', (SELECT id FROM category WHERE key = 'groceries'), 200, 'Costco'),
  ('name_contains', '美廉社', (SELECT id FROM category WHERE key = 'groceries'), 200, 'Simple Mart');

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '麥當勞', (SELECT id FROM category WHERE key = 'dining'), 190, 'McDonald''s'),
  ('name_contains', '摩斯', (SELECT id FROM category WHERE key = 'dining'), 190, 'MOS Burger'),
  ('name_contains', '肯德基', (SELECT id FROM category WHERE key = 'dining'), 190, 'KFC'),
  ('name_contains', '漢堡王', (SELECT id FROM category WHERE key = 'dining'), 190, 'Burger King'),
  ('name_contains', 'subway', (SELECT id FROM category WHERE key = 'dining'), 190, NULL),
  ('name_contains', '鬍鬚張', (SELECT id FROM category WHERE key = 'dining'), 190, NULL),
  ('name_contains', '池上', (SELECT id FROM category WHERE key = 'dining'), 190, 'bento chain');

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '星巴克', (SELECT id FROM category WHERE key = 'drinks'), 190, 'Starbucks'),
  ('name_contains', 'starbucks', (SELECT id FROM category WHERE key = 'drinks'), 190, NULL),
  ('name_contains', '路易莎', (SELECT id FROM category WHERE key = 'drinks'), 190, 'Louisa'),
  ('name_contains', 'louisa', (SELECT id FROM category WHERE key = 'drinks'), 190, NULL),
  ('name_contains', 'cama', (SELECT id FROM category WHERE key = 'drinks'), 190, NULL),
  ('name_contains', '丹堤', (SELECT id FROM category WHERE key = 'drinks'), 190, 'Dante'),
  ('name_contains', '五十嵐', (SELECT id FROM category WHERE key = 'drinks'), 190, 'bubble tea'),
  ('name_contains', '清心', (SELECT id FROM category WHERE key = 'drinks'), 190, 'bubble tea'),
  ('name_contains', '迷客夏', (SELECT id FROM category WHERE key = 'drinks'), 190, 'Milksha'),
  ('name_contains', '可不可', (SELECT id FROM category WHERE key = 'drinks'), 190, 'KEBUKE'),
  ('name_contains', '大苑子', (SELECT id FROM category WHERE key = 'drinks'), 190, NULL);

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '寶雅', (SELECT id FROM category WHERE key = 'personal'), 190, 'POYA'),
  ('name_contains', '康是美', (SELECT id FROM category WHERE key = 'personal'), 190, 'Cosmed'),
  ('name_contains', '屈臣氏', (SELECT id FROM category WHERE key = 'personal'), 190, 'Watsons'),
  ('name_contains', '日藥本舖', (SELECT id FROM category WHERE key = 'personal'), 190, NULL);

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '藥局', (SELECT id FROM category WHERE key = 'health'), 190, NULL),
  ('name_contains', '藥房', (SELECT id FROM category WHERE key = 'health'), 190, NULL),
  ('name_contains', '診所', (SELECT id FROM category WHERE key = 'health'), 190, NULL),
  ('name_contains', '醫院', (SELECT id FROM category WHERE key = 'health'), 190, NULL);

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '中油', (SELECT id FROM category WHERE key = 'transport'), 190, 'CPC'),
  ('name_contains', '台塑石油', (SELECT id FROM category WHERE key = 'transport'), 190, NULL),
  ('name_contains', '加油站', (SELECT id FROM category WHERE key = 'transport'), 190, NULL),
  ('name_contains', '停車場', (SELECT id FROM category WHERE key = 'transport'), 190, NULL),
  ('name_contains', '捷運', (SELECT id FROM category WHERE key = 'transport'), 190, NULL),
  ('name_contains', '高鐵', (SELECT id FROM category WHERE key = 'transport'), 190, NULL);

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '誠品', (SELECT id FROM category WHERE key = 'education'), 190, 'Eslite'),
  ('name_contains', '金石堂', (SELECT id FROM category WHERE key = 'education'), 190, NULL),
  ('name_contains', '墊腳石', (SELECT id FROM category WHERE key = 'education'), 190, NULL),
  ('name_contains', '三民書局', (SELECT id FROM category WHERE key = 'education'), 190, NULL);

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '燦坤', (SELECT id FROM category WHERE key = 'electronics'), 190, 'Tkec'),
  ('name_contains', '全國電子', (SELECT id FROM category WHERE key = 'electronics'), 190, NULL),
  ('name_contains', '順發', (SELECT id FROM category WHERE key = 'electronics'), 190, NULL);

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note) VALUES
  ('name_contains', '中華電信', (SELECT id FROM category WHERE key = 'services'), 190, NULL),
  ('name_contains', '台灣大哥大', (SELECT id FROM category WHERE key = 'services'), 190, NULL),
  ('name_contains', '遠傳', (SELECT id FROM category WHERE key = 'services'), 190, NULL),
  ('name_contains', '郵局', (SELECT id FROM category WHERE key = 'services'), 190, NULL);
