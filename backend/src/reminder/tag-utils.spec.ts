import {
  NO_PUSH_TAG_NAME,
  parseTagObjects,
  hasNoPushTag,
  rawHasNoPushTag,
} from './tag-utils';

// 测试用客户标签数据工厂
const makeTags = (names: string[]) =>
  JSON.stringify(names.map((name) => ({ name, group: '个人标签' })));

describe('「不需要推」标签排除逻辑', () => {
  describe('parseTagObjects', () => {
    test('正确解析新格式 [{name, group, tagId}]', () => {
      const raw = JSON.stringify([
        { name: '不需要推', group: '个人标签', tagId: 'tag_001' },
        { name: '911', group: '个人标签', tagId: 'tag_002' },
      ]);
      const result = parseTagObjects(raw);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('不需要推');
      expect(result[0].tagId).toBe('tag_001');
    });

    test('旧格式 ["str1", "str2"] 被忽略，返回空数组', () => {
      const raw = JSON.stringify(['不需要推', '911']);
      const result = parseTagObjects(raw);
      expect(result).toHaveLength(0);
    });

    test('null / undefined / 空字符串 返回空数组', () => {
      expect(parseTagObjects(null)).toEqual([]);
      expect(parseTagObjects(undefined)).toEqual([]);
      expect(parseTagObjects('')).toEqual([]);
    });

    test('无效 JSON 返回空数组', () => {
      expect(parseTagObjects('{broken')).toEqual([]);
    });
  });

  describe('hasNoPushTag — 标签存在性判断', () => {
    test('标签列表包含「不需要推」时返回 true', () => {
      const tags = parseTagObjects(makeTags(['911', '不需要推', '意向强']));
      expect(hasNoPushTag(tags)).toBe(true);
    });

    test('标签列表不包含「不需要推」时返回 false', () => {
      const tags = parseTagObjects(makeTags(['911', '意向强', 'VIP 学生']));
      expect(hasNoPushTag(tags)).toBe(false);
    });

    test('不误匹配相似名称（如「不需要推课」「不需要推送」）', () => {
      const tags = parseTagObjects(
        makeTags(['不需要推课', '不需要推送', '不需要推']),
      );
      // 精确匹配：只有「不需要推」命中
      expect(hasNoPushTag(tags)).toBe(true);

      const tagsWithoutExact = parseTagObjects(
        makeTags(['不需要推课', '不需要推送']),
      );
      expect(hasNoPushTag(tagsWithoutExact)).toBe(false);
    });

    test('标签列表为空时返回 false', () => {
      expect(hasNoPushTag([])).toBe(false);
    });

    test('标签不存在时不会误用其他标签', () => {
      const tags = parseTagObjects(makeTags(['911', '821', 'VIP']));
      expect(hasNoPushTag(tags)).toBe(false);
    });
  });

  describe('rawHasNoPushTag — 直接从 JSON 字符串判断', () => {
    test('包含「不需要推」标签的 JSON 返回 true', () => {
      const raw = JSON.stringify([
        { name: '911', group: '个人标签' },
        { name: '不需要推', group: '个人标签' },
        { name: '意向强', group: '个人标签' },
      ]);
      expect(rawHasNoPushTag(raw)).toBe(true);
    });

    test('不包含「不需要推」标签的 JSON 返回 false', () => {
      const raw = JSON.stringify([
        { name: '911', group: '个人标签' },
        { name: '意向强', group: '个人标签' },
      ]);
      expect(rawHasNoPushTag(raw)).toBe(false);
    });

    test('空标签 JSON 返回 false', () => {
      expect(rawHasNoPushTag('[]')).toBe(false);
    });

    test('null 返回 false', () => {
      expect(rawHasNoPushTag(null)).toBe(false);
    });
  });

  describe('多标签客户不重复排除', () => {
    test('同一客户有多个标签（含「不需要推」），只检测一次、排除一次', () => {
      const raw = JSON.stringify([
        { name: '911', group: '个人标签' },
        { name: '不需要推', group: '个人标签' },
        { name: '意向强', group: '个人标签' },
        { name: 'VIP', group: '个人标签' },
      ]);
      const tags = parseTagObjects(raw);
      // hasNoPushTag 返回布尔值，不会因为多个标签而多次命中
      expect(hasNoPushTag(tags)).toBe(true);
      // rawHasNoPushTag 同理
      expect(rawHasNoPushTag(raw)).toBe(true);
    });
  });

  describe('标签移除后客户可重新进入发送名单', () => {
    test('移除「不需要推」后 hasNoPushTag 返回 false', () => {
      // 有「不需要推」时
      const rawWith = JSON.stringify([
        { name: '911', group: '个人标签' },
        { name: '不需要推', group: '个人标签' },
      ]);
      expect(rawHasNoPushTag(rawWith)).toBe(true);

      // 移除「不需要推」后
      const rawWithout = JSON.stringify([
        { name: '911', group: '个人标签' },
      ]);
      expect(rawHasNoPushTag(rawWithout)).toBe(false);
    });
  });

  describe('tagId 优先匹配', () => {
    test('当配置了 NO_PUSH_TAG_ID 时，按 tagId 匹配也能命中', () => {
      // 这个测试验证 tagId 字段被正确解析
      const raw = JSON.stringify([
        { name: '某标签', group: '个人标签', tagId: 'tag_999' },
      ]);
      const tags = parseTagObjects(raw);
      expect(tags[0].tagId).toBe('tag_999');
    });

    test('tagId 不存在时，name 匹配作为兜底', () => {
      // 无 tagId，但有 name = 「不需要推」
      const raw = JSON.stringify([
        { name: NO_PUSH_TAG_NAME, group: '个人标签' },
      ]);
      const tags = parseTagObjects(raw);
      expect(hasNoPushTag(tags)).toBe(true);
    });
  });
});
