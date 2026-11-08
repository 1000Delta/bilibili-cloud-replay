// Synthetic fixtures only. No network, account data, or writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require(process.env.COLLECTION_MATCHING_MODULE || '../bilibili-cloud-replay.user.js');
const v = (aid, title, extra = {}) => ({ aid, title, ...extra });
test('collection normalization folds Unicode width, case and whitespace', () => {
  assert.equal(C.collectionNormalize('  ＪＡＶＡ\u3000 入门  '), 'java 入门');
});
test('extracts bracket topics and generated date/part suffixes without stripping sequel numbers', () => {
  assert(C.collectionKeywords('【原神】深境螺旋 2026-11-08 01').includes('原神'));
  assert(C.collectionKeywords('星露谷物语 2026-11-08 01').includes('星露谷物语'));
  assert(C.collectionKeywords('Civilization 6').includes('civilization 6'));
  assert(C.collectionKeywords('【原神】直播回放合集').includes('原神'));
  for (const text of ['直播', '回放', '录播', '【回放】', '1', '2026-11-08', '猫', '2026年11月08日']) assert.deepEqual(C.collectionKeywords(text), [], text);
});
test('new topic inference requires two distinct unassigned AIDs', () => {
  assert.equal(C.suggestCollections([v(1, '星露谷物语 2026-11-08 01')], []).length, 0);
  assert.equal(C.suggestCollections([v(1, '星露谷物语 2026-11-08 01'), v('1', '星露谷物语 2026-11-08 02')], []).length, 0);
  const groups = C.suggestCollections([v(1, '星露谷物语 2026-11-08 01'), v(2, '星露谷物语 2026-11-09 01')], []);
  assert.deepEqual(groups.find(g => g.keyword === '星露谷物语').aids, ['1', '2']);
});
test('existing titles match a single video, and ASCII substrings do not collide', () => {
  const groups = C.suggestCollections([v(1, 'Java 入门'), v(2, 'JavaScript 入门'), v(3, 'Google 搜索'), v(4, 'ＧＯ 入门')], [{id:10,title:'Java'},{id:11,title:'Go'}]);
  assert.deepEqual(groups.find(g => g.seasonId === '10').aids, ['1']);
  assert.deepEqual(groups.find(g => g.seasonId === '11').aids, ['4']);
});
test('Chinese topic phrases match existing collections and preserve ambiguous destinations', () => {
  const groups = C.suggestCollections([v(1, '今天玩原神深境螺旋')], [{id:10,title:'【原神】实况合集'},{id:11,title:'原神'}]);
  assert.deepEqual(groups.filter(g => g.keyword === '原神').map(g => g.seasonId), ['10','11']);
  assert(groups.every(g => !Object.hasOwn(g, 'selected')));
});
test('explicit rules match unrelated collection names and can suggest one new collection', () => {
  const groups = C.suggestCollections([v(1, '【空洞骑士】白宫')], [{id:10,title:'周末游戏'}], [{keyword:'空洞骑士',seasonId:10},{keyword:'白宫',title:'白宫挑战'}]);
  assert(groups.some(g => g.source === 'rule' && g.seasonId === '10' && g.aids[0] === '1'));
  assert(groups.some(g => g.source === 'rule' && g.seasonId === null && g.title === '白宫挑战'));
  assert.equal(C.suggestCollections([v(1, '空洞骑士')], [], [{keyword:'空洞骑士',seasonId:999}]).length, 0);
});
test('assigned, conflicting duplicate and invalid AIDs are excluded without mutating inputs', () => {
  const videos = [v(1, '原神', {seasonId:3}),v(2,'原神'),v('2','原神',{season_id:4}),v(3,'原神'),v('003','原神'),v(0,'原神'),v('bad','原神')];
  const collections = [{id:10,title:'原神'}], before = structuredClone({videos,collections});
  const groups = C.suggestCollections(videos, collections);
  assert.deepEqual(groups[0].aids, ['3']);
  assert.deepEqual({videos,collections}, before);
  assert.equal(groups[0].videos[0], videos[3]);
});
test('empty data and invalid custom keywords produce no suggestions', () => {
  assert.deepEqual(C.suggestCollections([],[]), []);
  assert.deepEqual(C.suggestCollections([v(1,'直播')],[],[{keyword:'直播'},{keyword:'1'}]), []);
});
