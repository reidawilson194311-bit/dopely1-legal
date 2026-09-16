import { postId } from './id.js';

const n = (...vals) => {
  for (const v of vals) {
    const num = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : v;
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
};

const s = (...vals) => vals.find((v) => typeof v === 'string' && v.trim()) || '';

const iso = (...vals) => {
  for (const v of vals) {
    if (!v) continue;
    const d = typeof v === 'number' ? new Date(v * (v > 1e12 ? 1 : 1000)) : new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
};

/** First line, or first sentence - the part of a caption doing the hook work. */
export function extractHook(caption) {
  const clean = String(caption || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#[\w]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const firstLine = clean.split(/(?<=[.!?])\s/)[0];
  return firstLine.slice(0, 160).trim();
}

/**
 * Every scraper returns a different shape and each actor changes its field
 * names occasionally, so each normalizer reads several candidates per field
 * and falls back to 0 / '' rather than throwing. A winner with a missing
 * `likes` is still a usable winner.
 */
export const normalize = {
  instagram(item) {
    const url = s(item.url, item.postUrl, item.displayUrl);
    const account = s(item.ownerUsername, item.username, item.ownerFullName);
    const caption = s(item.caption, item.text, item.title);
    return {
      id: postId('instagram', url),
      platform: 'instagram',
      account,
      accountUrl: account ? `https://www.instagram.com/${account}/` : '',
      url,
      caption,
      hook: extractHook(caption),
      views: n(item.videoPlayCount, item.videoViewCount, item.playCount, item.viewCount),
      likes: n(item.likesCount, item.likes),
      comments: n(item.commentsCount, item.comments),
      shares: n(item.sharesCount, item.reshareCount),
      durationSec: n(item.videoDuration, item.duration),
      postedAt: iso(item.timestamp, item.takenAtTimestamp, item.createTime),
      thumbnailUrl: s(item.displayUrl, item.thumbnailUrl, item.imageUrl),
      mediaType: s(item.type, item.productType) || 'video',
    };
  },

  tiktok(item) {
    const account = s(item.authorMeta?.name, item.authorMeta?.nickName, item.authorUniqueId);
    const url = s(item.webVideoUrl, item.postPage, item.url);
    const caption = s(item.text, item.desc, item.title);
    return {
      id: postId('tiktok', url),
      platform: 'tiktok',
      account,
      accountUrl: account ? `https://www.tiktok.com/@${account}` : '',
      url,
      caption,
      hook: extractHook(caption),
      views: n(item.playCount, item.stats?.playCount, item.videoMeta?.playCount),
      likes: n(item.diggCount, item.stats?.diggCount),
      comments: n(item.commentCount, item.stats?.commentCount),
      shares: n(item.shareCount, item.stats?.shareCount),
      durationSec: n(item.videoMeta?.duration, item.duration),
      postedAt: iso(item.createTimeISO, item.createTime),
      thumbnailUrl: s(item.videoMeta?.coverUrl, item.covers?.default, item.thumbnail),
      mediaType: 'video',
    };
  },

  youtube(item) {
    const account = s(item.channelName, item.channelUsername, item.channelTitle);
    const url = s(item.url, item.videoUrl, item.id && `https://www.youtube.com/watch?v=${item.id}`);
    const caption = s(item.title, item.text);
    return {
      id: postId('youtube', url),
      platform: 'youtube',
      account,
      accountUrl: s(item.channelUrl),
      url,
      caption,
      hook: extractHook(caption),
      views: n(item.viewCount, item.views),
      likes: n(item.likes, item.likeCount),
      comments: n(item.commentsCount, item.commentCount),
      shares: 0,
      durationSec: n(item.duration, item.lengthSeconds),
      postedAt: iso(item.date, item.publishedAt, item.uploadDate),
      thumbnailUrl: s(item.thumbnailUrl, item.thumbnail),
      mediaType: 'video',
    };
  },
};

export default normalize;
