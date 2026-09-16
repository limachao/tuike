/** 「不需要推」标签名：群发时自动排除 */
export const NO_PUSH_TAG_NAME = '不需要推';
/** 「不需要推」标签 ID（从环境变量配置，优先按 ID 匹配） */
export const NO_PUSH_TAG_ID = process.env.NO_PUSH_TAG_ID ?? '';

/**
 * 解析 wecom_tags JSON，返回带 tagId 的标签对象数组。
 * 兼容两种存储格式：
 *   新格式：[{"name":"意向强","group":"我的标签组","tagId":"123"}, ...]
 *   旧格式（升级前）：["24年客户", "王老师抖音", ...] —— 旧格式全部忽略
 */
export function parseTagObjects(
  raw: unknown,
): Array<{ name: string; tagId?: string }> {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((t) => {
        if (t && typeof t === 'object' && 'name' in t) {
          const n: string = String((t as any).name ?? '').trim();
          if (!n) return null;
          const tid = (t as any).tag_id ?? (t as any).tagId;
          return { name: n, ...(tid ? { tagId: String(tid) } : {}) };
        }
        return null;
      })
      .filter((x): x is { name: string; tagId?: string } => !!x);
  } catch {
    return [];
  }
}

/**
 * 判断标签列表中是否包含「不需要推」标签。
 * 优先按 tagId 匹配（如果配置了 NO_PUSH_TAG_ID），否则按 name 精确匹配。
 */
export function hasNoPushTag(
  tags: Array<{ name: string; tagId?: string }>,
): boolean {
  return tags.some(
    (t) =>
      t.name === NO_PUSH_TAG_NAME ||
      (NO_PUSH_TAG_ID !== '' && t.tagId === NO_PUSH_TAG_ID),
  );
}

/**
 * 从 wecom_tags JSON 字符串中判断是否包含「不需要推」标签。
 * 便捷封装：parse + hasNoPushTag 一步到位。
 */
export function rawHasNoPushTag(raw: unknown): boolean {
  return hasNoPushTag(parseTagObjects(raw));
}
