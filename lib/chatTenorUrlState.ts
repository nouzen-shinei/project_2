interface ChatTenorMediaFormats {
  tinygif?: { url?: string };
  nanogif?: { url?: string };
  gif?: { url?: string };
  mediumgif?: { url?: string };
}

export function resolveChatTenorIdFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.hostname.includes('tenor.com')) {
      return null;
    }

    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    if (parts.length < 1) {
      return null;
    }

    return parts[0] || null;
  } catch {
    return null;
  }
}

export function resolveChatTenorWebpToGifGuess(url: string): string | null {
  if (!/tenor\.com/.test(url) || !/\.webp($|\?)/i.test(url)) {
    return null;
  }

  return url.replace(/\.webp(\?|$)/i, '.gif$1');
}

export function resolveChatTenorPostsLookupUrl(params: {
  tenorBaseUrl: string;
  tenorApiKey: string | null | undefined;
  tenorId: string | null | undefined;
}): string | null {
  const { tenorBaseUrl, tenorApiKey, tenorId } = params;

  if (!tenorApiKey || !tenorId) {
    return null;
  }

  return `${tenorBaseUrl}/posts?ids=${encodeURIComponent(tenorId)}&key=${tenorApiKey}&media_filter=basic`;
}

export function resolveChatTenorGifCandidateUrl(params: {
  mediaFormats: ChatTenorMediaFormats | null | undefined;
  fallbackUrl?: string | null;
}): string | null {
  const { mediaFormats, fallbackUrl = null } = params;

  const nextUrl =
    mediaFormats?.tinygif?.url ||
    mediaFormats?.nanogif?.url ||
    mediaFormats?.gif?.url ||
    mediaFormats?.mediumgif?.url ||
    null;

  return nextUrl || fallbackUrl;
}
