import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import * as ImageManipulator from 'expo-image-manipulator';
import CryptoJS from 'crypto-js';
import { logger } from '@/lib/logger';
import { clampRange, deriveRangeFromMessages, partitionMessagesByLimit, rangesOverlap, safeTimestamp, type PinRange } from '@/lib/chatHistoryPolicy';
import type { ChatMessage, FileAttachment } from './chatService';
import { webMediaCache } from './webMediaCache';
import { isAudioFile, isImageFile, isVideoFile } from '@/lib/fileUtils';
import { getChatPaginationProfile } from '@/lib/chatPaginationConfig';
import { tenantService } from '@/services/tenantService';

const CACHE_VERSION = 'v4';
const CACHE_PREFIX = `chat-cache:${CACHE_VERSION}:`;
const MEDIA_INDEX_KEY = `${CACHE_PREFIX}media-index`;
const MEDIA_ROOT = FileSystem?.documentDirectory || FileSystem?.cacheDirectory || null;
const MEDIA_DIR = MEDIA_ROOT ? `${MEDIA_ROOT.replace(/\/$/, '')}/chat-media` : null;
const MEDIA_PREVIEW_INDEX_KEY = `${CACHE_PREFIX}media-preview-index`;
const MEDIA_PREVIEW_DIR = MEDIA_ROOT ? `${MEDIA_ROOT.replace(/\/$/, '')}/chat-media-previews` : null;
const ENCRYPTION_KEY_STORAGE = 'chat_cache_v3_encryption_key';
const LEGACY_ENCRYPTION_KEY_STORAGE = `${CACHE_PREFIX}encryption-key`;
const { cacheLimit: MAX_CACHED_MESSAGES } = getChatPaginationProfile('native');
const MAX_HISTORICAL_CHUNKS = 6;
const HISTORICAL_CHUNK_SIZE = Math.max(48, Math.min(256, Math.floor(MAX_CACHED_MESSAGES / 2)));
const CACHE_FRESHNESS_MS = 45_000;
const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MEDIA_PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MEDIA_PREVIEW_MAX = 256;
const LOW_PRIORITY_IDLE_DELAY_MS = 450;
const MEDIA_PREVIEW_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IMAGE_PREVIEW_MAX_DIMENSION = 320;
const IMAGE_PREVIEW_COMPRESS = 0.35;
const AUDIO_PLACEHOLDER_DATA_URI =
	"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='%23343154'/><path d='M24 20h8v20a6 6 0 1 1-8.5 5.3' stroke='%23A78BFA' stroke-width='4' fill='none' stroke-linecap='round' stroke-linejoin='round'/><circle cx='44' cy='28' r='6' fill='%238B5CF6'/><circle cx='44' cy='40' r='4' fill='%236B21A8'/></svg>";

interface CachedChunkDescriptor {
	id: string;
	oldestTimestamp: string | null;
	newestTimestamp: string | null;
	savedAt: number;
 	messageCount: number;
 	pinned?: boolean;
 	pinStartTimestamp?: string | null;
 	pinEndTimestamp?: string | null;
}

interface CachedConversationChunk extends CachedChunkDescriptor {
	messages: ChatMessage[];
}

const DOWNLOAD_PRIORITY = {
	high: 0,
	normal: 1,
	low: 2,
} as const;

type DownloadPriority = keyof typeof DOWNLOAD_PRIORITY;

interface ConcurrencyProfile {
	hydration: number;
	downloads: number;
	deviceType: Device.DeviceType | null;
	totalMemory: number | null;
}

interface DownloadTask {
	remoteUrl: string;
	fileName?: string;
	priority: number;
	priorityLabel: DownloadPriority;
	resolve: (value: string) => void;
	reject: (reason: unknown) => void;
	promise: Promise<string>;
	aborted?: boolean;
}

export interface HydratedAttachment extends FileAttachment {
	resolvedUrl?: string;
	previewUri?: string;
	/** H.264 transcoded URL — used preferentially over resolvedUrl for video on web. */
	transcodedUrl?: string;
}

export interface HydratedChatMessage extends ChatMessage {
	attachments?: HydratedAttachment[];
	localMediaAvailable?: boolean;
}

interface CachedConversation {
	messages: ChatMessage[];
	hasMore: boolean;
	oldestTimestamp: string | null;
	lastSyncedAt: number;
}

interface MediaIndexEntry {
	uri: string;
	updatedAt: number;
}

type MediaIndex = Record<string, MediaIndexEntry>;

type MediaCachedCallback = (remoteUrl: string, localUri: string) => void;

interface MemoizedPreviewPayload {
	attachments?: HydratedAttachment[];
	localMediaAvailable: boolean;
}

interface MemoizedPreviewEntry {
	fingerprint: string;
	cachedAt: number;
	payload: MemoizedPreviewPayload;
}

class ChatCacheService {
	private mediaIndex: MediaIndex | null = null;
	private mediaIndexLoaded = false;
	private mediaPreviewIndex: MediaIndex | null = null;
	private mediaPreviewIndexLoaded = false;
	private downloadPromises = new Map<string, Promise<string>>();
	private downloadTasks = new Map<string, DownloadTask>();
	private downloadQueue: DownloadTask[] = [];
	private activeDownloadCount = 0;
	private lowPriorityDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private mediaDirectoryReady = false;
	private mediaPreviewDirectoryReady = false;
	private lastCleanup = 0;
	private lastPreviewCleanup = 0;
	private mediaPreviewMemo = new Map<string, MemoizedPreviewEntry>();
	private previewPromises = new Map<string, Promise<string | undefined>>();
	private encryptionKeyPromise: Promise<string> | null = null;
	private concurrencyProfilePromise: Promise<ConcurrencyProfile> | null = null;
	private concurrencyProfile: ConcurrencyProfile | null = null;
	private attachmentPrefetchQueue: Array<{ remoteUrl: string; fileName?: string; priority: DownloadPriority }> = [];
	private attachmentPrefetchSet = new Set<string>();
	private attachmentPrefetchTimer: ReturnType<typeof setTimeout> | null = null;
	private attachmentPrefetching = false;

	private createAbortError(): Error {
		const error = new Error('Aborted');
		(error as any).name = 'AbortError';
		return error;
	}

	private createDeferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (reason: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	private isLikelyPreviewUri(uri?: string | null): boolean {
		if (!uri) {
			return false;
		}
		const normalized = uri.trim().toLowerCase();
		if (!normalized) {
			return false;
		}
		if (normalized.startsWith('file://')) {
			if (MEDIA_PREVIEW_DIR) {
				const previewRoot = MEDIA_PREVIEW_DIR.trim().toLowerCase();
				if (previewRoot && normalized.startsWith(previewRoot)) {
					return true;
				}
			}
			if (normalized.includes('/chat-media-previews/')) {
				return true;
			}
		}
		return false;
	}

	private async mapWithConcurrency<T, R>(
		items: T[],
		limit: number,
		iterator: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
		signal?: AbortSignal
	): Promise<R[]> {
		if (!items.length) {
			return [];
		}
		const poolSize = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
		const checkAborted = () => {
			if (signal?.aborted) {
				throw this.createAbortError();
			}
		};
		const results: R[] = new Array(items.length);
		let cursor = 0;

		const worker = async () => {
			while (true) {
				checkAborted();
				const index = cursor < items.length ? cursor++ : -1;
				if (index === -1) {
					break;
				}
				results[index] = await iterator(items[index], index, signal);
			}
		};

		await Promise.all(Array.from({ length: poolSize }, worker));
		return results;
	}

	private async awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) {
			return await promise;
		}
		if (signal.aborted) {
			throw this.createAbortError();
		}
		return await new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener?.('abort', onAbort as any);
				reject(this.createAbortError());
			};
			signal.addEventListener?.('abort', onAbort as any, { once: true });
			promise
				.then((value) => {
					signal.removeEventListener?.('abort', onAbort as any);
					resolve(value);
				})
				.catch((error) => {
					signal.removeEventListener?.('abort', onAbort as any);
					reject(error);
				});
		});
	}

	private async resolveTenantCacheNamespace(): Promise<string> {
		try {
			const tenantId = await tenantService.getCachedSelectedTenant();
			return (tenantId || 'no-tenant').trim();
		} catch {
			return 'no-tenant';
		}
	}

	private async conversationKey(userA: string, userB: string): Promise<string> {
		const tenantNamespace = await this.resolveTenantCacheNamespace();
		const pair = [userA.toLowerCase(), userB.toLowerCase()].sort();
		return `${CACHE_PREFIX}${tenantNamespace}:${pair[0]}__${pair[1]}`;
	}

	private async chunkListKey(userA: string, userB: string): Promise<string> {
		return `${await this.conversationKey(userA, userB)}:chunks`;
	}

	private async chunkEntryKey(userA: string, userB: string, chunkId: string): Promise<string> {
		return `${await this.conversationKey(userA, userB)}:chunk:${chunkId}`;
	}

	private generateChunkId(): string {
		return `chunk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	private sortChunkDescriptors(descriptors: CachedChunkDescriptor[]): CachedChunkDescriptor[] {
		return descriptors
			.slice()
			.sort((a, b) => {
				const left = safeTimestamp(a.oldestTimestamp) ?? Number.NEGATIVE_INFINITY;
				const right = safeTimestamp(b.oldestTimestamp) ?? Number.NEGATIVE_INFINITY;
				if (left !== right) {
					return left - right;
				}
				const leftNewest = safeTimestamp(a.newestTimestamp) ?? left;
				const rightNewest = safeTimestamp(b.newestTimestamp) ?? right;
				return leftNewest - rightNewest;
			});
	}

	private async readChunkDescriptors(userA: string, userB: string): Promise<CachedChunkDescriptor[]> {
		const key = await this.chunkListKey(userA, userB);
		try {
			const raw = await AsyncStorage.getItem(key);
			if (!raw) {
				return [];
			}
			const parsed = await this.decryptPayload<CachedChunkDescriptor[]>(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed
				.filter((descriptor) => Boolean(descriptor?.id))
				.map((descriptor) => ({
					...descriptor,
					messageCount: descriptor.messageCount ?? 0,
					pinned: Boolean(descriptor.pinned),
					pinStartTimestamp: descriptor.pinStartTimestamp ?? null,
					pinEndTimestamp: descriptor.pinEndTimestamp ?? null,
				}));
		} catch (error) {
			logger.debug('Failed to read chat chunk descriptors', { userA, userB, error });
			return [];
		}
	}

	private async persistChunkDescriptors(userA: string, userB: string, descriptors: CachedChunkDescriptor[]): Promise<void> {
		const key = await this.chunkListKey(userA, userB);
		const sanitized = this.sortChunkDescriptors(
			descriptors.filter((descriptor) => Boolean(descriptor?.id))
		);
		if (!sanitized.length) {
			try {
				await AsyncStorage.removeItem(key);
			} catch (error) {
				logger.debug('Failed to clear empty chunk descriptor list', { userA, userB, error });
			}
			return;
		}
		try {
			const payload = await this.encryptPayload(sanitized);
			await AsyncStorage.setItem(key, payload);
		} catch (error) {
			logger.warn('Failed to persist chat chunk descriptors', { userA, userB, error });
		}
	}

	private async deleteChunkEntry(userA: string, userB: string, chunkId: string): Promise<void> {
		try {
			await AsyncStorage.removeItem(await this.chunkEntryKey(userA, userB, chunkId));
		} catch (error) {
			logger.debug('Failed to delete chat chunk', { userA, userB, chunkId, error });
		}
	}

	private async persistChunkEntry(
		userA: string,
		userB: string,
		messages: ChatMessage[],
		options?: { pinned?: boolean; pinRange?: PinRange | null }
	): Promise<CachedChunkDescriptor | null> {
		const normalized = messages
			.filter((message) => Boolean(message?.timestamp))
			.map((message) => ({ ...message }))
			.sort((a, b) => (safeTimestamp(a.timestamp) ?? 0) - (safeTimestamp(b.timestamp) ?? 0));
		if (!normalized.length) {
			return null;
		}
		const descriptor: CachedChunkDescriptor = {
			id: this.generateChunkId(),
			oldestTimestamp: normalized[0]?.timestamp ?? null,
			newestTimestamp: normalized[normalized.length - 1]?.timestamp ?? null,
			savedAt: Date.now(),
			messageCount: normalized.length,
			pinned: Boolean(options?.pinned),
			pinStartTimestamp: options?.pinRange?.startTimestamp ?? null,
			pinEndTimestamp: options?.pinRange?.endTimestamp ?? null,
		};
		try {
			const payload = await this.encryptPayload<CachedConversationChunk>({
				...descriptor,
				messages: normalized,
			});
			await AsyncStorage.setItem(await this.chunkEntryKey(userA, userB, descriptor.id), payload);
			return descriptor;
		} catch (error) {
			logger.warn('Failed to persist chat history chunk', { userA, userB, error });
			return null;
		}
	}

	private async loadChunkPayload(userA: string, userB: string, chunkId: string): Promise<CachedConversationChunk | null> {
		try {
			const raw = await AsyncStorage.getItem(await this.chunkEntryKey(userA, userB, chunkId));
			if (!raw) {
				return null;
			}
			const parsed = await this.decryptPayload<CachedConversationChunk>(raw);
			if (!parsed?.messages?.length) {
				return null;
			}
			return parsed;
		} catch (error) {
			logger.debug('Failed to load chat history chunk', { userA, userB, chunkId, error });
			return null;
		}
	}

	private async pruneChunkDescriptors(
		userA: string,
		userB: string,
		descriptors: CachedChunkDescriptor[]
	): Promise<CachedChunkDescriptor[]> {
		const working = this.sortChunkDescriptors(descriptors);
		if (working.length <= MAX_HISTORICAL_CHUNKS) {
			return working;
		}
		const removals: CachedChunkDescriptor[] = [];
		while (working.length > MAX_HISTORICAL_CHUNKS) {
			const removableIndex = working.findIndex((descriptor) => !descriptor.pinned);
			const targetIndex = removableIndex === -1 ? 0 : removableIndex;
			const [removed] = working.splice(targetIndex, 1);
			if (removed) {
				removals.push(removed);
			}
		}
		if (removals.length) {
			await Promise.all(removals.map((descriptor) => this.deleteChunkEntry(userA, userB, descriptor.id)));
		}
		return working;
	}

	private descriptorIntersectsRange(descriptor: CachedChunkDescriptor, range: PinRange | null): boolean {
		if (!range) {
			return false;
		}
		return rangesOverlap(
			{ startTimestamp: descriptor.oldestTimestamp, endTimestamp: descriptor.newestTimestamp },
			range
		);
	}

	private messagesIntersectRange(messages: ChatMessage[], range: PinRange | null): boolean {
		if (!range || !messages.length) {
			return false;
		}
		const derived = deriveRangeFromMessages(messages);
		return rangesOverlap(derived, range);
	}

	private filterMessagesWithinRange(messages: ChatMessage[], range: PinRange): ChatMessage[] {
		const normalizedRange = clampRange(range);
		if (!normalizedRange) {
			return [];
		}
		const start = safeTimestamp(normalizedRange.startTimestamp);
		const end = safeTimestamp(normalizedRange.endTimestamp);
		return messages.filter((message) => {
			const value = safeTimestamp(message.timestamp);
			if (value == null) {
				return false;
			}
			if (start != null && value < start) {
				return false;
			}
			if (end != null && value > end) {
				return false;
			}
			return true;
		});
	}

	private applyPinRange(descriptors: CachedChunkDescriptor[], range: PinRange): boolean {
		let pinned = false;
		for (const descriptor of descriptors) {
			if (this.descriptorIntersectsRange(descriptor, range)) {
				descriptor.pinned = true;
				descriptor.pinStartTimestamp = descriptor.pinStartTimestamp ?? range.startTimestamp ?? descriptor.oldestTimestamp ?? null;
				descriptor.pinEndTimestamp = descriptor.pinEndTimestamp ?? range.endTimestamp ?? descriptor.newestTimestamp ?? null;
				pinned = true;
			}
		}
		return pinned;
	}

	private async persistHistoricalChunks(
		userA: string,
		userB: string,
		payload: { spilled: ChatMessage[]; pinRange?: PinRange | null; pinMessages?: ChatMessage[] | null }
	): Promise<void> {
		const normalizedRange = clampRange(payload.pinRange);
		const hasSpill = Array.isArray(payload.spilled) && payload.spilled.length > 0;
		if (!hasSpill && !normalizedRange) {
			return;
		}
		const descriptors = await this.readChunkDescriptors(userA, userB);
		const working = descriptors.slice();
		const dedupeKey = (oldest: string | null, newest: string | null) => `${oldest ?? 'null'}::${newest ?? 'null'}`;
		const existingKeys = new Set(working.map((descriptor) => dedupeKey(descriptor.oldestTimestamp, descriptor.newestTimestamp)));

		const queueChunkPersist = async (messages: ChatMessage[], forcePinned = false) => {
			const normalized = messages
				.filter((message) => Boolean(message?.timestamp))
				.sort((a, b) => (safeTimestamp(a.timestamp) ?? 0) - (safeTimestamp(b.timestamp) ?? 0));
			if (!normalized.length) {
				return;
			}
			const oldestTimestamp = normalized[0]?.timestamp ?? null;
			const newestTimestamp = normalized[normalized.length - 1]?.timestamp ?? null;
			const key = dedupeKey(oldestTimestamp, newestTimestamp);
			if (existingKeys.has(key)) {
				return;
			}
			const descriptor = await this.persistChunkEntry(userA, userB, normalized, {
				pinned: forcePinned || this.messagesIntersectRange(normalized, normalizedRange),
				pinRange: forcePinned ? normalizedRange ?? deriveRangeFromMessages(normalized) : normalizedRange,
			});
			if (descriptor) {
				working.push(descriptor);
				existingKeys.add(key);
			}
		};

		if (hasSpill) {
			const normalizedSpill = payload.spilled
				.filter((message) => Boolean(message?.timestamp))
				.sort((a, b) => (safeTimestamp(a.timestamp) ?? 0) - (safeTimestamp(b.timestamp) ?? 0));
			for (let cursor = 0; cursor < normalizedSpill.length; cursor += HISTORICAL_CHUNK_SIZE) {
				const chunk = normalizedSpill.slice(cursor, cursor + HISTORICAL_CHUNK_SIZE);
				await queueChunkPersist(chunk);
			}
		}

		if (normalizedRange) {
			const pinned = this.applyPinRange(working, normalizedRange);
			if (!pinned) {
				const sourceMessages = payload.pinMessages ?? [];
				const subset = sourceMessages.length
					? this.filterMessagesWithinRange(sourceMessages, normalizedRange) || sourceMessages
					: [];
				if (subset.length) {
					await queueChunkPersist(subset, true);
				}
			}
		}

		const pruned = await this.pruneChunkDescriptors(userA, userB, working);
		await this.persistChunkDescriptors(userA, userB, pruned);
	}

	private async loadHistoricalMessagesBefore(
		userA: string,
		userB: string,
		beforeTimestamp: string | null,
		limit: number
	): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
		const descriptors = await this.readChunkDescriptors(userA, userB);
		if (!descriptors.length) {
			return { messages: [], hasMore: false };
		}
		const cutoff = beforeTimestamp ? safeTimestamp(beforeTimestamp) : null;
		const eligibleDescriptors = descriptors
			.filter((descriptor) => {
				if (!descriptor.newestTimestamp || cutoff == null) {
					return true;
				}
				const newest = safeTimestamp(descriptor.newestTimestamp);
				return newest == null || newest < cutoff;
			})
			.sort((a, b) => (safeTimestamp(b.newestTimestamp) ?? 0) - (safeTimestamp(a.newestTimestamp) ?? 0));
		if (!eligibleDescriptors.length) {
			return { messages: [], hasMore: false };
		}
		const target = Math.max(1, limit);
		const collected: ChatMessage[] = [];
		let inspected = 0;
		for (const descriptor of eligibleDescriptors) {
			if (collected.length >= target * 2) {
				break;
			}
			const chunk = await this.loadChunkPayload(userA, userB, descriptor.id);
			if (!chunk?.messages?.length) {
				continue;
			}
			const filtered = chunk.messages.filter((message) => {
				const ts = safeTimestamp(message.timestamp);
				if (ts == null) {
					return false;
				}
				if (cutoff != null && ts >= cutoff) {
					return false;
				}
				return true;
			});
			if (!filtered.length) {
				continue;
			}
			collected.push(...filtered);
			inspected += 1;
		}
		const normalizedMessages = collected.sort((a, b) => (safeTimestamp(a.timestamp) ?? 0) - (safeTimestamp(b.timestamp) ?? 0));
		const hasMore = eligibleDescriptors.length > inspected;
		return { messages: normalizedMessages, hasMore };
	}

	private async clearHistoricalChunks(userA: string, userB: string): Promise<void> {
		const descriptors = await this.readChunkDescriptors(userA, userB);
		if (descriptors.length) {
			await Promise.all(descriptors.map((descriptor) => this.deleteChunkEntry(userA, userB, descriptor.id)));
		}
		try {
			await AsyncStorage.removeItem(await this.chunkListKey(userA, userB));
		} catch (error) {
			logger.debug('Failed to clear chat chunk descriptor list', { userA, userB, error });
		}
	}

	private buildPreviewKey(remoteUrl: string): string {
		return `${remoteUrl}::preview`;
	}

	private buildMediaFingerprint(message: ChatMessage): string {
		const attachmentsFingerprint = Array.isArray(message.attachments)
			? message.attachments
					.map((attachment) =>
						[
							attachment.url || 'na',
							attachment.fileName || 'na',
							attachment.thumbnailUrl || 'na',
							attachment.fileType || 'na',
						].join('|')
					)
					.join(';')
			: 'no-attachments';

		return [
			attachmentsFingerprint,
			message.gif?.url || 'no-gif',
			message.gif?.thumbnailUrl || 'no-gif-thumb',
			message.sticker?.url || 'no-sticker',
			message.timestamp || 'no-timestamp',
		].join('::');
	}

	private getMemoizedPreview(messageId: string | undefined, fingerprint: string): MemoizedPreviewPayload | null {
		if (!messageId) return null;
		const entry = this.mediaPreviewMemo.get(messageId);
		if (!entry) return null;
		if (entry.fingerprint !== fingerprint) {
			this.mediaPreviewMemo.delete(messageId);
			return null;
		}
		if (Date.now() - entry.cachedAt > MEDIA_PREVIEW_TTL_MS) {
			this.mediaPreviewMemo.delete(messageId);
			return null;
		}
		return {
			attachments: entry.payload.attachments
				? entry.payload.attachments.map((attachment) => ({ ...attachment }))
				: undefined,
			localMediaAvailable: entry.payload.localMediaAvailable,
		};
	}

	private storeMemoizedPreview(
		messageId: string | undefined,
		fingerprint: string,
		payload: MemoizedPreviewPayload
	): void {
		if (!messageId) return;

		if (this.mediaPreviewMemo.size >= MEDIA_PREVIEW_MAX) {
			const oldestKey = this.mediaPreviewMemo.keys().next().value as string | undefined;
			if (oldestKey) {
				this.mediaPreviewMemo.delete(oldestKey);
			}
		}

		this.mediaPreviewMemo.set(messageId, {
			fingerprint,
			cachedAt: Date.now(),
			payload: {
				attachments: payload.attachments
					? payload.attachments.map((attachment) => ({ ...attachment }))
					: undefined,
				localMediaAvailable: payload.localMediaAvailable,
			},
		});
	}

	private async ensureConcurrencyProfile(): Promise<ConcurrencyProfile> {
		if (this.concurrencyProfile) {
			return this.concurrencyProfile;
		}
		if (!this.concurrencyProfilePromise) {
			this.concurrencyProfilePromise = this.computeConcurrencyProfile();
		}
		this.concurrencyProfile = await this.concurrencyProfilePromise;
		return this.concurrencyProfile;
	}

	private async computeConcurrencyProfile(): Promise<ConcurrencyProfile> {
		try {
			const memoryPromise = (() => {
				const candidate = Device as unknown as Record<string, () => Promise<number>>;
				if (typeof candidate.getTotalMemoryAsync === 'function') {
					return candidate.getTotalMemoryAsync();
				}
				if (typeof candidate.getMaxMemoryAsync === 'function') {
					return candidate.getMaxMemoryAsync();
				}
				return Promise.resolve<number | null>(null);
			})();
			const [deviceType, totalMemory] = await Promise.all([
				Device.getDeviceTypeAsync().catch(() => null),
				memoryPromise.catch(() => null),
			]);
			const memoryBytes = typeof totalMemory === 'number' ? totalMemory : null;
			const memoryGb = memoryBytes ? memoryBytes / (1024 * 1024 * 1024) : null;
			const isLowMemory = memoryGb != null && memoryGb < 3;
			const downloads = isLowMemory ? 1 : Platform.OS === 'android' ? 2 : 3;
			const hydration = isLowMemory ? 2 : 4;
			const profile: ConcurrencyProfile = {
				hydration,
				downloads,
				deviceType,
				totalMemory: memoryBytes,
			};
			logger.metric('chat.cache.deviceProfile', {
				deviceType,
				totalMemory: memoryBytes,
				hydration,
				downloads,
			});
			return profile;
		} catch (error) {
			logger.warn('Failed to compute concurrency profile', { error });
			return {
				hydration: 3,
				downloads: 2,
				deviceType: null,
				totalMemory: null,
			};
		}
	}

	public async getTelemetryContext(): Promise<ConcurrencyProfile> {
		return await this.ensureConcurrencyProfile();
	}

	private async getEncryptionKey(): Promise<string> {
		if (this.encryptionKeyPromise) {
			return this.encryptionKeyPromise;
		}
		this.encryptionKeyPromise = (async () => {
			try {
				const secureStoreReadable = Platform.OS !== 'web' && typeof SecureStore?.getItemAsync === 'function';
				const secureStoreWritable = Platform.OS !== 'web' && typeof SecureStore?.setItemAsync === 'function';
				const secureStoreDeletable = Platform.OS !== 'web' && typeof SecureStore?.deleteItemAsync === 'function';
				let key: string | null = null;
				if (secureStoreReadable) {
					try {
						key = await SecureStore.getItemAsync(ENCRYPTION_KEY_STORAGE);
					} catch (error) {
						logger.warn('chat.cache.secureStore.readFailed', { error, stage: 'read-new' });
					}
				}
				if (!key) {
					try {
						key = await AsyncStorage.getItem(ENCRYPTION_KEY_STORAGE);
					} catch (error) {
						logger.warn('chat.cache.asyncStorage.readFailed', { error, stage: 'read-new' });
					}
				}
				if (!key) {
					try {
						key = await AsyncStorage.getItem(LEGACY_ENCRYPTION_KEY_STORAGE);
					} catch {}
					if (!key && secureStoreReadable) {
						try {
							key = await SecureStore.getItemAsync(LEGACY_ENCRYPTION_KEY_STORAGE);
						} catch {}
					}
					if (key) {
						if (secureStoreWritable) {
							try {
								await SecureStore.setItemAsync(ENCRYPTION_KEY_STORAGE, key);
							} catch (error) {
								logger.warn('chat.cache.secureStore.writeFailed', { error, stage: 'migrate' });
							}
						}
						try {
							await AsyncStorage.setItem(ENCRYPTION_KEY_STORAGE, key);
						} catch (error) {
							logger.warn('chat.cache.asyncStorage.writeFailed', { error, stage: 'migrate' });
						}
						try {
							await AsyncStorage.removeItem(LEGACY_ENCRYPTION_KEY_STORAGE);
						} catch {}
						if (secureStoreDeletable) {
							try {
								await SecureStore.deleteItemAsync(LEGACY_ENCRYPTION_KEY_STORAGE);
							} catch {}
						}
					}
				}
				if (!key) {
					const bytes = await Crypto.getRandomBytesAsync(32);
					key = Array.from(bytes)
						.map((value) => value.toString(16).padStart(2, '0'))
						.join('');
					if (secureStoreWritable) {
						try {
							await SecureStore.setItemAsync(ENCRYPTION_KEY_STORAGE, key);
						} catch (error) {
							logger.warn('chat.cache.secureStore.writeFailed', { error, stage: 'create' });
						}
					}
					try {
						await AsyncStorage.setItem(ENCRYPTION_KEY_STORAGE, key);
					} catch (error) {
						logger.warn('chat.cache.asyncStorage.writeFailed', { error, stage: 'create' });
					}
				}
				return key;
			} catch (error) {
				logger.warn('Failed to provision chat cache encryption key', { error });
				return 'fallback-chat-cache-key';
			}
		})();
		return this.encryptionKeyPromise;
	}

	private deriveKeyMaterial(secret: string): { key: CryptoJS.lib.WordArray; iv: CryptoJS.lib.WordArray } {
		const hashHex = CryptoJS.SHA512(secret).toString(CryptoJS.enc.Hex);
		const keyHex = hashHex.slice(0, 64).padEnd(64, '0');
		const ivHex = hashHex.slice(64, 96).padEnd(32, '0');
		return {
			key: CryptoJS.enc.Hex.parse(keyHex),
			iv: CryptoJS.enc.Hex.parse(ivHex),
		};
	}

	private async encryptPayload<T>(value: T): Promise<string> {
		const key = await this.getEncryptionKey();
		const payload = JSON.stringify(value);
		const { key: keyWordArray, iv } = this.deriveKeyMaterial(key);
		const encrypted = CryptoJS.AES.encrypt(payload, keyWordArray, {
			iv,
			mode: CryptoJS.mode.CBC,
			padding: CryptoJS.pad.Pkcs7,
		}).toString();
		return `v2:${encrypted}`;
	}

	private async decryptPayload<T>(payload: string): Promise<T | null> {
		const key = await this.getEncryptionKey();
		const errors: Array<{ stage: string; error: unknown }> = [];
		if (payload.startsWith('v2:')) {
			try {
				const { key: keyWordArray, iv } = this.deriveKeyMaterial(key);
				const bytes = CryptoJS.AES.decrypt(payload.slice(3), keyWordArray, {
					iv,
					mode: CryptoJS.mode.CBC,
					padding: CryptoJS.pad.Pkcs7,
				});
				const decrypted = bytes.toString(CryptoJS.enc.Utf8);
				if (!decrypted) {
					throw new Error('Empty decrypted payload');
				}
				return JSON.parse(decrypted) as T;
			} catch (error) {
				errors.push({ stage: 'v2', error });
			}
		}
		try {
			const bytes = CryptoJS.AES.decrypt(payload, key);
			const decrypted = bytes.toString(CryptoJS.enc.Utf8);
			if (decrypted) {
				return JSON.parse(decrypted) as T;
			}
			throw new Error('Empty decrypted payload');
		} catch (error) {
			errors.push({ stage: 'legacy', error });
		}
		try {
			return JSON.parse(payload) as T;
		} catch (parseError) {
			errors.push({ stage: 'plain', error: parseError });
		}
		logger.warn('Failed to decrypt chat cache entry', { attempts: errors });
		return null;
	}

	async getConversation(userA: string, userB: string): Promise<CachedConversation | null> {
		try {
			const raw = await AsyncStorage.getItem(await this.conversationKey(userA, userB));
			if (!raw) return null;
			const parsed = await this.decryptPayload<CachedConversation>(raw);
			if (!parsed || !Array.isArray(parsed.messages)) {
				return null;
			}
			return this.normalizeConversation(parsed);
		} catch (error) {
			logger.warn('Failed to read cached conversation', { userA, userB, error });
			return null;
		}
	}

	async clearConversation(userA: string, userB: string): Promise<void> {
		try {
			await AsyncStorage.removeItem(await this.conversationKey(userA, userB));
			await this.clearHistoricalChunks(userA, userB);
		} catch (error) {
			logger.warn('Failed to clear cached conversation', { userA, userB, error });
		}
	}

	isConversationFresh(lastSyncedAt: number | undefined | null, freshnessMs: number = CACHE_FRESHNESS_MS): boolean {
		if (!lastSyncedAt) return false;
		return Date.now() - lastSyncedAt < freshnessMs;
	}

	private normalizeConversation(conversation: CachedConversation): CachedConversation {
		if (!conversation.messages) {
			conversation.messages = [];
		}
		const sortedMessages = conversation.messages
			.map((msg) => ({
				...msg,
				sender: (msg.sender || '').toLowerCase(),
				recipientId: msg.recipientId?.toLowerCase(),
			}))
			.sort((a, b) => {
				const left = safeTimestamp(a.timestamp) ?? 0;
				const right = safeTimestamp(b.timestamp) ?? 0;
				return left - right;
			});

		conversation.messages = sortedMessages;

		const earliestTimestamp = sortedMessages[0]?.timestamp ?? null;
		if (!conversation.oldestTimestamp) {
			conversation.oldestTimestamp = earliestTimestamp;
		} else if (earliestTimestamp) {
			const existingTs = safeTimestamp(conversation.oldestTimestamp);
			const earliestTs = safeTimestamp(earliestTimestamp);
			if (!existingTs || (earliestTs && earliestTs < existingTs)) {
				conversation.oldestTimestamp = earliestTimestamp;
			}
		}

		if (typeof conversation.hasMore !== 'boolean') {
			conversation.hasMore = sortedMessages.length >= Math.min(MAX_CACHED_MESSAGES, 64);
		} else if (!conversation.hasMore && sortedMessages.length >= MAX_CACHED_MESSAGES) {
			conversation.hasMore = true;
		}

		if (!conversation.lastSyncedAt) {
			conversation.lastSyncedAt = Date.now();
		}

		return conversation;
	}

	async saveConversation(
		userA: string,
		userB: string,
		incoming: ChatMessage[],
		meta?: {
			hasMore?: boolean;
			oldestTimestamp?: string | null;
			timestampOverride?: number;
			pinRange?: PinRange | null;
			pinMessages?: ChatMessage[] | null;
		}
	): Promise<CachedConversation> {
		const key = await this.conversationKey(userA, userB);
		const existing = await this.getConversation(userA, userB);
		const merged = this.mergeMessages(existing?.messages || [], incoming);
		const { retained, spilled } = this.trimMessages(merged, {
			pinRange: meta?.pinRange,
			pinMessages: meta?.pinMessages,
		});
		const oldestTimestamp = meta?.oldestTimestamp ?? retained[0]?.timestamp ?? existing?.oldestTimestamp ?? null;
		const hasMore = (() => {
			if (meta?.hasMore != null) return meta.hasMore;
			if (merged.length > retained.length) return true;
			if (existing?.hasMore === false) return false;
			return existing?.hasMore ?? true;
		})();
		const conversation: CachedConversation = {
			messages: retained,
			hasMore,
			oldestTimestamp,
			lastSyncedAt: meta?.timestampOverride ?? Date.now(),
		};

		try {
			const payload = await this.encryptPayload(conversation);
			await AsyncStorage.setItem(key, payload);
		} catch (error) {
			logger.warn('Failed to persist chat cache', { userA, userB, error });
		}

		const pinMessages = meta?.pinMessages ?? (meta?.pinRange ? incoming : null);
		try {
			await this.persistHistoricalChunks(userA, userB, {
				spilled,
				pinRange: meta?.pinRange,
				pinMessages: pinMessages ?? undefined,
			});
		} catch (error) {
			logger.debug('Failed to persist chat history chunks', { userA, userB, error });
		}

		return conversation;
	}

	async appendMessages(userA: string, userB: string, incoming: ChatMessage[]): Promise<CachedConversation | null> {
		if (!incoming.length) {
			return this.getConversation(userA, userB);
		}
		return this.saveConversation(userA, userB, incoming);
	}

	async pinHistoricalRange(userA: string, userB: string, range: PinRange | null, messages?: ChatMessage[]): Promise<void> {
		const normalized = clampRange(range);
		if (!normalized) {
			return;
		}
		await this.persistHistoricalChunks(userA, userB, {
			spilled: [],
			pinRange: normalized,
			pinMessages: messages ?? null,
		});
	}

	async getCachedPageBefore(
		userA: string,
		userB: string,
		beforeTimestamp: string | null,
		limit: number
	): Promise<{ messages: ChatMessage[]; hasMoreInCache: boolean; hasRemoteMore: boolean; oldestTimestamp: string | null }> {
		const conversation = await this.getConversation(userA, userB);
		const requestLimit = Math.max(1, Math.min(limit, MAX_CACHED_MESSAGES));
		const conversationMessages: ChatMessage[] = Array.isArray(conversation?.messages)
			? (conversation?.messages as ChatMessage[])
			: [];
		const cutoff = beforeTimestamp ? safeTimestamp(beforeTimestamp) : null;
		const eligible = conversationMessages.filter((message) => {
			if (!message?.timestamp) {
				return false;
			}
			const ts = safeTimestamp(message.timestamp);
			if (ts == null) {
				return false;
			}
			if (cutoff == null) {
				return true;
			}
			return ts < cutoff;
		});

		let historical: { messages: ChatMessage[]; hasMore: boolean } = { messages: [], hasMore: false };
		if (eligible.length < requestLimit) {
			try {
				historical = await this.loadHistoricalMessagesBefore(
					userA,
					userB,
					beforeTimestamp,
					requestLimit - eligible.length
				);
			} catch (error) {
				logger.debug('Failed to read historical chat chunks', { userA, userB, error });
				historical = { messages: [], hasMore: false };
			}
		}

		const combined = [...historical.messages, ...eligible];
		if (!combined.length) {
			return {
				messages: [],
				hasMoreInCache: historical.hasMore,
				hasRemoteMore: Boolean(conversation?.hasMore),
				oldestTimestamp: conversation?.oldestTimestamp ?? beforeTimestamp ?? null,
			};
		}

		const slice = combined.slice(-requestLimit);
		const oldestTimestamp = slice[0]?.timestamp ?? conversation?.oldestTimestamp ?? beforeTimestamp ?? null;
		const hasMoreInCache = combined.length > slice.length || historical.hasMore;

		return {
			messages: slice,
			hasMoreInCache,
			hasRemoteMore: Boolean(conversation?.hasMore),
			oldestTimestamp,
		};
	}

	async hydrateMessages(
		userA: string,
		userB: string,
		messages: ChatMessage[],
		onMediaCached?: MediaCachedCallback,
		options?: { signal?: AbortSignal }
	): Promise<HydratedChatMessage[]> {
		if (!Array.isArray(messages) || messages.length === 0) {
			return [];
		}

		const signal = options?.signal;
		const ensureNotAborted = () => {
			if (signal?.aborted) {
				throw this.createAbortError();
			}
		};

		const isLocalUri = (uri?: string | null): boolean => {
			if (!uri) return false;
			return uri.startsWith('file://') || uri.startsWith('blob:');
		};

		const profile = await this.ensureConcurrencyProfile();
		const concurrency = Math.max(2, profile.hydration);
		const hydrated = await this.mapWithConcurrency(messages, concurrency, async (message) => {
			ensureNotAborted();
			const chatMessage = message as ChatMessage;
			if ('deleted' in chatMessage && chatMessage.deleted) {
				return {
					...message,
					attachments: undefined,
					localMediaAvailable: false,
				} as HydratedChatMessage;
			}
			const fingerprint = this.buildMediaFingerprint(message);
			const cachedPreview = this.getMemoizedPreview(message.id, fingerprint);
			if (cachedPreview) {
				return {
					...message,
					attachments: cachedPreview.attachments ?? message.attachments,
					localMediaAvailable: cachedPreview.localMediaAvailable,
				} as HydratedChatMessage;
			}

			ensureNotAborted();
			const enrichedAttachments = await this.prepareAttachments(message.attachments, onMediaCached, { signal });
			const localAvailable = Boolean(
				enrichedAttachments?.some((att) => isLocalUri(att.resolvedUrl) || isLocalUri(att.previewUri))
			);

			const hydratedMessage: HydratedChatMessage = {
				...message,
				attachments: enrichedAttachments ?? message.attachments,
				localMediaAvailable: localAvailable,
			};

			this.storeMemoizedPreview(message.id, fingerprint, {
				attachments: hydratedMessage.attachments as HydratedAttachment[] | undefined,
				localMediaAvailable: localAvailable,
			});

			return hydratedMessage;
		}, signal);

		// Preserve ascending timestamp order
		hydrated.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
		return hydrated;
	}

	scheduleAttachmentPrefetch(messages: ReadonlyArray<ChatMessage | HydratedChatMessage> | null | undefined): void {
		if (!messages || messages.length === 0) {
			return;
		}

		const targets: Array<{ remoteUrl: string; fileName?: string; priority: DownloadPriority }> = [];
		for (const message of messages) {
			if (!message) {
				continue;
			}
			if (Array.isArray(message.attachments)) {
				for (const attachment of message.attachments) {
					if (!attachment) {
						continue;
					}
					const hydratedCandidate = (attachment as HydratedAttachment);
					if (isVideoFile(attachment.fileType, attachment.fileName)) {
						// For video files: never enqueue the video URL itself.
						// Reasons:
						//   1. Videos can be 10–200 MB — eagerly downloading them wastes bandwidth.
						//   2. The original H.265 is deleted after transcoding → any token variant
						//      of that URL returns 403, polluting the console with errors.
						//   3. The VideoPlayer handles its own codec-aware source loading.
						// Only prefetch the thumbnail (small JPEG) when available.
						const videoPreviewCandidate = hydratedCandidate.previewUri || attachment.thumbnailUrl;
						if (videoPreviewCandidate) {
							this.enqueuePrefetchTarget(videoPreviewCandidate, attachment.fileName, Math.min(attachment.fileSize ?? 0, 300000), targets, 'high');
						}
					} else {
						const primaryAttachmentUrl = attachment.url || hydratedCandidate.resolvedUrl;
						this.enqueuePrefetchTarget(primaryAttachmentUrl, attachment.fileName, attachment.fileSize, targets);
						const previewCandidate = hydratedCandidate.previewUri || attachment.thumbnailUrl;
						if (previewCandidate) {
							this.enqueuePrefetchTarget(previewCandidate, attachment.fileName, Math.min(attachment.fileSize ?? 0, 300000), targets, 'high');
						}
					}
				}
			}
		}

		if (!targets.length) {
			return;
		}

		const limit = 25;
		const selected = targets.slice(0, limit);
		const skipped = targets.slice(limit);
		for (const target of selected) {
			this.attachmentPrefetchQueue.push(target);
		}
		for (const target of skipped) {
			this.attachmentPrefetchSet.delete(target.remoteUrl);
		}

		this.kickAttachmentPrefetch();
	}

	private enqueuePrefetchTarget(
		remoteUrl: string | undefined,
		fileName: string | undefined,
		fileSize: number | undefined,
		collector: Array<{ remoteUrl: string; fileName?: string; priority: DownloadPriority }>,
		priorityOverride?: DownloadPriority
	): void {
		if (!remoteUrl) {
			return;
		}
		if (!/^https?:/i.test(remoteUrl)) {
			return;
		}
		if (this.attachmentPrefetchSet.has(remoteUrl)) {
			return;
		}
		const priority = priorityOverride ?? this.determinePrefetchPriority(fileSize);
		this.attachmentPrefetchSet.add(remoteUrl);
		collector.push({ remoteUrl, fileName, priority });
	}

	private determinePrefetchPriority(fileSize?: number): DownloadPriority {
		if (!fileSize || fileSize <= 512 * 1024) {
			return 'high';
		}
		if (fileSize <= 5 * 1024 * 1024) {
			return 'normal';
		}
		return 'low';
	}

	private kickAttachmentPrefetch(): void {
		if (this.attachmentPrefetching) {
			return;
		}
		if (this.attachmentPrefetchQueue.length === 0) {
			return;
		}
		if (this.attachmentPrefetchTimer) {
			return;
		}
		this.attachmentPrefetchTimer = setTimeout(() => {
			this.attachmentPrefetchTimer = null;
			void this.drainAttachmentPrefetchQueue();
		}, 75);
	}

	private async drainAttachmentPrefetchQueue(): Promise<void> {
		if (this.attachmentPrefetching) {
			return;
		}
		this.attachmentPrefetching = true;
		try {
			const profile = await this.ensureConcurrencyProfile();
			const batchSize = Math.max(1, Math.min(3, profile.downloads));
			while (this.attachmentPrefetchQueue.length > 0) {
				const batch = this.attachmentPrefetchQueue.splice(0, batchSize);
				await Promise.all(
					batch.map(async (item) => {
						try {
							await this.prepareMediaUri(item.remoteUrl, item.fileName, false, undefined, {
								priority: item.priority,
								lazy: false,
							});
						} catch (error) {
							if ((error as any)?.name !== 'AbortError') {
								logger.debug('chat.cache.prefetch.failed', { remoteUrl: item.remoteUrl, error });
							}
						} finally {
							this.attachmentPrefetchSet.delete(item.remoteUrl);
						}
					})
				);
				if (this.attachmentPrefetchQueue.length > 0) {
					await new Promise<void>((resolve) => setTimeout(resolve, 80));
				}
			}
		} finally {
			this.attachmentPrefetching = false;
		}
	}

	async getMediaForDownload(
		remoteUrl: string,
		fileName?: string,
		localHint?: string,
		priority: DownloadPriority = 'normal',
		options?: { lazy?: boolean }
	): Promise<string> {
		if (!remoteUrl) {
			return localHint || remoteUrl;
		}
		if (remoteUrl.startsWith('data:') || remoteUrl.startsWith('blob:')) {
			return remoteUrl;
		}
		if (Platform.OS === 'web') {
			// Never download video files on web — they are 10–200 MB and the VideoPlayer
			// manages its own codec-aware loading via <video> elements. Caching them via
			// webMediaCache wastes bandwidth and causes 403 errors for deleted originals
			// (H.265 files removed from Firebase Storage after transcoding).
			if (isVideoFile(undefined, fileName || remoteUrl)) {
				return remoteUrl;
			}
			try {
				if (options?.lazy) {
					const cached = await webMediaCache.getCached(remoteUrl, MEDIA_TTL_MS);
					if (cached) {
						return cached;
					}
					webMediaCache
						.fetchAndCache(remoteUrl, MEDIA_TTL_MS)
						.catch((error) => {
							logger.debug('Deferred web media download failed', { remoteUrl, error });
						});
					return remoteUrl;
				}
				const resolved = await webMediaCache.fetchAndCache(remoteUrl, MEDIA_TTL_MS);
				return resolved || remoteUrl;
			} catch (error) {
				logger.debug('Web media download failed, falling back to remote', { remoteUrl, error });
				return remoteUrl;
			}
		}
		if (!MEDIA_DIR) {
			return remoteUrl;
		}

		await this.ensureMediaIndex();

		const trimmedHint = localHint?.trim();
		const safeLocalHint =
			trimmedHint && trimmedHint.startsWith('file://') && !this.isLikelyPreviewUri(trimmedHint)
				? trimmedHint
				: undefined;

		if (safeLocalHint) {
			const exists = await this.fileExists(safeLocalHint);
			if (exists) {
				await this.rememberMedia(remoteUrl, safeLocalHint);
				return safeLocalHint;
			}
		}

		const entry = this.mediaIndex?.[remoteUrl];
		if (entry) {
			const entryUri = entry.uri;
			if (this.isLikelyPreviewUri(entryUri)) {
				await this.forgetMedia(remoteUrl);
			} else if (await this.fileExists(entryUri)) {
				return entryUri;
			} else {
				await this.forgetMedia(remoteUrl);
			}
		}

		if (options?.lazy) {
			return remoteUrl;
		}

		try {
			const localUri = await this.queueDownload(remoteUrl, fileName, undefined, priority);
			if (localUri && localUri.startsWith('file://')) {
				return localUri;
			}
		} catch (error) {
			logger.debug('Media download failed, falling back to remote', { remoteUrl, error });
		}

		return remoteUrl;
	}

	private mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
		if (!incoming.length) return existing.slice();
		const map = new Map<string, ChatMessage>();
		[...existing, ...incoming].forEach((msg) => {
			const key = this.messageKey(msg);
			map.set(key, {
				...msg,
				sender: (msg.sender || '').toLowerCase(),
				recipientId: msg.recipientId?.toLowerCase(),
			});
		});

		return Array.from(map.values()).sort(
			(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
		);
	}

	private messageKey(msg: ChatMessage): string {
		const attachmentsSignature = Array.isArray(msg.attachments)
			? msg.attachments.map((att) => `${att?.url ?? ''}:${att?.fileName ?? ''}`).join(',')
			: '';
		return (
			msg.id ||
			`${(msg.sender || '').toLowerCase()}|${(msg.recipientId || '').toLowerCase()}|${msg.timestamp}|${msg.text || ''}|${attachmentsSignature}|${msg.gif?.url || ''}|${msg.sticker?.url || ''}`
		);
	}

	private trimMessages(
		messages: ChatMessage[],
		options?: { pinRange?: PinRange | null; pinMessages?: ChatMessage[] | null }
	): { retained: ChatMessage[]; spilled: ChatMessage[] } {
		const limit = MAX_CACHED_MESSAGES;
		if (messages.length <= limit) {
			return { retained: messages, spilled: [] };
		}
		const messageMap = new Map<string, ChatMessage>();
		for (const message of messages) {
			messageMap.set(this.messageKey(message), message);
		}
		const normalizedRange = clampRange(options?.pinRange);
		const pinSource = (() => {
			const explicitPins = Array.isArray(options?.pinMessages) ? options?.pinMessages ?? [] : [];
			if (explicitPins.length) {
				return explicitPins;
			}
			if (!normalizedRange) {
				return [] as ChatMessage[];
			}
			return this.filterMessagesWithinRange(messages, normalizedRange);
		})();

		const resolvedPinned = pinSource
			.slice()
			.map((candidate) => {
				const resolved = messageMap.get(this.messageKey(candidate));
				return resolved ?? candidate;
			})
			.filter((message) => Boolean(message?.timestamp))
			.sort((a, b) => (safeTimestamp(a.timestamp) ?? 0) - (safeTimestamp(b.timestamp) ?? 0));

		let retainedKeys = new Set<string>();
		const retainedPinned: ChatMessage[] = [];
		for (const message of resolvedPinned) {
			const key = this.messageKey(message);
			if (retainedKeys.has(key)) {
				continue;
			}
			retainedKeys.add(key);
			retainedPinned.push(message);
		}

		let slots = limit - retainedKeys.size;
		const newestBuffer: ChatMessage[] = [];
		for (let index = messages.length - 1; index >= 0 && slots > 0; index--) {
			const message = messages[index];
			const key = this.messageKey(message);
			if (retainedKeys.has(key)) {
				continue;
			}
			retainedKeys.add(key);
			newestBuffer.push(message);
			slots -= 1;
		}

		let combined = [...retainedPinned, ...newestBuffer];
		if (combined.length > limit) {
			combined = combined.slice(-limit);
			retainedKeys = new Set(combined.map((message) => this.messageKey(message)));
		}

		const retained = combined.sort((a, b) => (safeTimestamp(a.timestamp) ?? 0) - (safeTimestamp(b.timestamp) ?? 0));
		const retainedKeySet = new Set(retained.map((message) => this.messageKey(message)));
		const spilled = messages.filter((message) => !retainedKeySet.has(this.messageKey(message)));
		return { retained, spilled };
	}

	private async generateImagePreview(remoteUrl: string, fileName?: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!MEDIA_PREVIEW_DIR) {
			return undefined;
		}

		await this.ensureMediaPreviewDirectory();
		await this.ensureMediaPreviewIndex();

		const previewKey = this.buildPreviewKey(remoteUrl);
		const existingEntry = this.mediaPreviewIndex?.[previewKey];
		if (existingEntry) {
			const isFresh = Date.now() - existingEntry.updatedAt < MEDIA_PREVIEW_FILE_TTL_MS;
			if (isFresh && (await this.fileExists(existingEntry.uri))) {
				return existingEntry.uri;
			}
		}

		const inFlight = this.previewPromises.get(previewKey);
		if (inFlight) {
			return await this.awaitWithAbort(inFlight, signal);
		}

		const previewPromise = (async () => {
			try {
				const hash = await Crypto.digestStringAsync(
					Crypto.CryptoDigestAlgorithm.SHA1,
					`${remoteUrl}:preview:${fileName || ''}`
				);
				const targetPath = `${MEDIA_PREVIEW_DIR}/${hash}.jpg`;
				const sourcePath = `${MEDIA_PREVIEW_DIR}/${hash}-raw`;
				if (await this.fileExists(targetPath)) {
					await this.rememberMediaPreview(previewKey, targetPath);
					return targetPath;
				}

				const download = FileSystem.createDownloadResumable(remoteUrl, sourcePath);
				let aborted = false;
				const handleAbort = () => {
					aborted = true;
					download.pauseAsync().catch(() => undefined);
				};
				signal?.addEventListener?.('abort', handleAbort as any, { once: true });

				try {
					const result = await download.downloadAsync();
					if (!result) {
						throw new Error('Preview download failed without result');
					}
					if (result.status !== 200) {
						throw new Error(`Preview download failed with status ${result.status}`);
					}
					if (signal?.aborted) {
						throw this.createAbortError();
					}

					const manipResult = await ImageManipulator.manipulateAsync(
						result.uri,
						[{ resize: { width: IMAGE_PREVIEW_MAX_DIMENSION } }],
						{ compress: IMAGE_PREVIEW_COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
					);

					if (!manipResult?.uri) {
						return undefined;
					}

					await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => undefined);
					await FileSystem.moveAsync({ from: manipResult.uri, to: targetPath });
					await this.rememberMediaPreview(previewKey, targetPath);
					return targetPath;
				} finally {
					signal?.removeEventListener?.('abort', handleAbort as any);
					await FileSystem.deleteAsync(sourcePath, { idempotent: true }).catch(() => undefined);
					if (aborted) {
						await FileSystem.deleteAsync(`${sourcePath}.part`, { idempotent: true }).catch(() => undefined);
					}
				}
			} finally {
				this.previewPromises.delete(previewKey);
			}
		})().catch((error) => {
			this.previewPromises.delete(previewKey);
			if ((error as any)?.name === 'AbortError') {
				throw error;
			}
			logger.debug('Failed to generate image preview', { remoteUrl, error });
			return undefined;
		});

		this.previewPromises.set(previewKey, previewPromise);
		return await this.awaitWithAbort(previewPromise, signal);
	}

	private async ensureAttachmentPreview(
		attachment: FileAttachment,
		options?: { signal?: AbortSignal }
	): Promise<string | undefined> {
		const signal = options?.signal;
		const explicitPreview = attachment.thumbnailUrl;
		if (explicitPreview) {
			if (Platform.OS === 'web') {
				return explicitPreview;
			}
			try {
				const prepared = await this.prepareMediaUri(explicitPreview, attachment.fileName, false, undefined, {
					signal,
					priority: 'normal',
					lazy: false,
				});
				return prepared || explicitPreview;
			} catch (error) {
				if ((error as any)?.name === 'AbortError') {
					throw error;
				}
				logger.debug('Falling back to remote preview thumbnail', { url: explicitPreview, error });
				return explicitPreview;
			}
		}

		if (isAudioFile(attachment.fileType || '', attachment.fileName)) {
			return AUDIO_PLACEHOLDER_DATA_URI;
		}

		if (!isImageFile(attachment.fileType || '', attachment.fileName)) {
			return undefined;
		}

		try {
			return await this.generateImagePreview(attachment.url, attachment.fileName, signal);
		} catch (error) {
			if ((error as any)?.name === 'AbortError') {
				throw error;
			}
			logger.debug('Falling back to full image for preview', { url: attachment.url, error });
			return undefined;
		}
	}

	private async prepareAttachments(
		attachments?: FileAttachment[] | null,
		onMediaCached?: MediaCachedCallback,
		options?: { signal?: AbortSignal }
	): Promise<HydratedAttachment[] | undefined> {
		if (!attachments || attachments.length === 0) {
			return undefined;
		}

		const signal = options?.signal;
		const profile = await this.ensureConcurrencyProfile();
		const concurrency = Math.max(1, Math.min(3, profile.downloads + 1));
		const result = await this.mapWithConcurrency(attachments, concurrency, async (attachment) => {
			const previewUri = await this.ensureAttachmentPreview(attachment, { signal });

			// For video attachments, resolve the server-transcoded H.264 URL from
			// Firestore. The server transcodes HEVC → H.264 asynchronously after upload;
			// the transcoded URL plays in every browser including Android Chrome/Edge.
			let transcodedUrl: string | undefined = attachment.transcodedUrl;
			if (!transcodedUrl && isVideoFile(attachment.fileType, attachment.fileName)) {
				// Check if the RTDB message already has transcodedUrl (written back
				// by the transcoder after completing). This is the fastest path and
				// avoids a Firestore round-trip.
				const rtdbTranscoded = (attachment as any).transcodedUrl as string | undefined;
				if (typeof rtdbTranscoded === 'string' && rtdbTranscoded.trim().length > 0) {
					transcodedUrl = rtdbTranscoded.trim();
				} else {
					try {
						transcodedUrl = await this.resolveTranscodedUrl(attachment.url);
					} catch {
						// Non-fatal: fall back to original URL
					}
				}
			}

			if (previewUri) {
				return {
					...attachment,
					thumbnailUrl: previewUri,
					previewUri,
					resolvedUrl: previewUri,
					...(transcodedUrl ? { transcodedUrl } : {}),
				} as HydratedAttachment;
			}

			// For video files: never use the full video URL as a preview fallback.
		// Attempting to download/cache the video URL here causes 403 errors for
		// transcoded videos (original H.265 is deleted from Firebase Storage after
		// transcoding). The VideoPlayer generates a frame capture when the video plays.
		if (isVideoFile(attachment.fileType, attachment.fileName) && !attachment.thumbnailUrl) {
			return {
				...attachment,
				...(transcodedUrl ? { transcodedUrl } : {}),
			} as HydratedAttachment;
		}

		const fallbackPreview = attachment.thumbnailUrl || attachment.url;
			const hydratedPreview = await this.prepareMediaUri(
				fallbackPreview,
				attachment.fileName,
				false,
				onMediaCached,
				{
					signal,
					priority: attachment.thumbnailUrl ? 'normal' : 'low',
					lazy: !attachment.thumbnailUrl,
				}
			);

			const resolvedPreview = hydratedPreview || fallbackPreview;
			return {
				...attachment,
				thumbnailUrl: resolvedPreview,
				previewUri: resolvedPreview,
				resolvedUrl: resolvedPreview,
				...(transcodedUrl ? { transcodedUrl } : {}),
			} as HydratedAttachment;
		}, signal);

		return result;
	}

	/**
	 * Looks up the server-side transcoded H.264 URL for a video from Firestore.
	 * The backend writes to videoTranscodes/{sha256(path)} after transcoding,
	 * with originalUrl as a field for client-side lookup.
	 * Returns undefined if not transcoded yet or if lookup fails.
	 * Only runs on web — native players support HEVC natively.
	 */
	private async resolveTranscodedUrl(originalUrl: string): Promise<string | undefined> {
		if (Platform.OS !== 'web') {
			return undefined;
		}
		if (!originalUrl || (!originalUrl.startsWith('http://') && !originalUrl.startsWith('https://'))) {
			return undefined;
		}
		try {
			const { getFirestore, collection, query, where, limit, getDocs } = await import('firebase/firestore');
			const { getApp } = await import('firebase/app');
			const db = getFirestore(getApp());
			// Query by originalUrl only — no status filter.
			// The status field can be 'error' (stale from a retry of the already-deleted
			// original) while transcodedUrl is valid. We check transcodedUrl presence in
			// code instead of relying on the status field being correct.
			const q = query(
				collection(db, 'videoTranscodes'),
				where('originalUrl', '==', originalUrl),
				limit(1)
			);
			// Best-effort AbortController for cancelling the pending Firestore promise on timeout.
			const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => {
					controller?.abort();
					reject(new Error('timeout'));
				}, 5000)
			);
			const snap = await Promise.race([getDocs(q), timeoutPromise]);
			if (snap.empty) return undefined;
			const data = snap.docs[0].data();
			// Return transcodedUrl only if it is a non-empty string.
			// Ignore documents that only have status fields but no transcodedUrl yet.
			const transcodedUrl = data.transcodedUrl;
			return typeof transcodedUrl === 'string' && transcodedUrl.trim().length > 0
				? transcodedUrl.trim()
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async prepareMediaUri(
		remoteUrl?: string,
		fileName?: string,
		waitForDownload: boolean = false,
		onMediaCached?: MediaCachedCallback,
		options?: { signal?: AbortSignal; priority?: DownloadPriority; lazy?: boolean }
	): Promise<string | undefined> {
		if (!remoteUrl) return undefined;
		if (remoteUrl.startsWith('data:') || remoteUrl.startsWith('blob:')) {
			return remoteUrl;
		}

		const signal = options?.signal;
		if (signal?.aborted) {
			throw this.createAbortError();
		}
		const priority = options?.priority ?? (waitForDownload ? 'high' : 'normal');
		const lazy = options?.lazy ?? false;

		if (Platform.OS === 'web') {
			// Never download video files on web — same reason as getMediaForDownload.
			if (isVideoFile(undefined, fileName || remoteUrl)) {
				return remoteUrl;
			}
			try {
				const cached = await webMediaCache.getCached(remoteUrl, MEDIA_TTL_MS);
				if (cached) {
					onMediaCached?.(remoteUrl, cached);
					return cached;
				}

				if (waitForDownload) {
					const objectUrl = await webMediaCache.fetchAndCache(remoteUrl, MEDIA_TTL_MS);
					if (onMediaCached && objectUrl && objectUrl.startsWith('blob:')) {
						onMediaCached(remoteUrl, objectUrl);
					}
					return objectUrl;
				}

				if (!lazy) {
					webMediaCache
						.fetchAndCache(remoteUrl, MEDIA_TTL_MS)
						.then((objectUrl) => {
							if (objectUrl && objectUrl.startsWith('blob:')) {
								onMediaCached?.(remoteUrl, objectUrl);
							}
						})
						.catch((error) => {
							logger.debug('Deferred web media download failed', { remoteUrl, error });
						});
				}
			} catch (error) {
				logger.debug('Web media cache lookup failed', { remoteUrl, error });
			}
			return remoteUrl;
		}

		if (!MEDIA_DIR) {
			return remoteUrl;
		}

		await this.ensureMediaIndex();

		const entry = this.mediaIndex?.[remoteUrl];
		if (entry && (await this.fileExists(entry.uri))) {
			return entry.uri;
		}

		const shouldDownload = waitForDownload || !lazy;
		if (!shouldDownload) {
			return remoteUrl;
		}

		const downloadTask = this.queueDownload(remoteUrl, fileName, signal, priority)
			.then(async (localUri) => {
				if (localUri && localUri.startsWith('file://')) {
					if (onMediaCached) {
						onMediaCached(remoteUrl, localUri);
					}
					return localUri;
				}
				return remoteUrl;
			})
			.catch((error) => {
				if ((error as any)?.name === 'AbortError') {
					throw error;
				}
				logger.debug('Deferred media download failed', { remoteUrl, error });
				return remoteUrl;
			});

		if (waitForDownload) {
			return await this.awaitWithAbort(downloadTask, signal);
		}

		this.awaitWithAbort(downloadTask, signal).catch(() => undefined);
		return remoteUrl;
	}

	private async ensureMediaIndex(): Promise<void> {
		if (this.mediaIndexLoaded) return;
		this.mediaIndexLoaded = true;
		try {
			const raw = await AsyncStorage.getItem(MEDIA_INDEX_KEY);
			this.mediaIndex = raw ? (JSON.parse(raw) as MediaIndex) : {};
		} catch (error) {
			logger.warn('Failed to load media index', error);
			this.mediaIndex = {};
		}

		await this.cleanupMediaIndex();
	}

	private async rememberMedia(remoteUrl: string, localUri: string): Promise<void> {
		if (this.isLikelyPreviewUri(localUri)) {
			await this.forgetMedia(remoteUrl);
			return;
		}
		await this.ensureMediaIndex();
		if (!this.mediaIndex) {
			this.mediaIndex = {};
		}
		this.mediaIndex[remoteUrl] = { uri: localUri, updatedAt: Date.now() };
		try {
			await AsyncStorage.setItem(MEDIA_INDEX_KEY, JSON.stringify(this.mediaIndex));
		} catch (error) {
			logger.warn('Failed to update media index', { remoteUrl, error });
		}
	}

	private async forgetMedia(remoteUrl: string): Promise<void> {
		if (!remoteUrl) {
			return;
		}
		await this.ensureMediaIndex();
		if (!this.mediaIndex || !this.mediaIndex[remoteUrl]) {
			return;
		}
		delete this.mediaIndex[remoteUrl];
		try {
			await AsyncStorage.setItem(MEDIA_INDEX_KEY, JSON.stringify(this.mediaIndex));
		} catch (error) {
			logger.warn('Failed to prune media index', { remoteUrl, error });
		}
	}

	private async ensureMediaDirectory(): Promise<void> {
		if (this.mediaDirectoryReady || !MEDIA_DIR) return;
		try {
			const info = await FileSystem.getInfoAsync(MEDIA_DIR);
			if (!info.exists) {
				await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
			}
			this.mediaDirectoryReady = true;
		} catch (error) {
			logger.warn('Failed to ensure media directory', error);
		}
	}

	private async ensureMediaPreviewDirectory(): Promise<void> {
		if (this.mediaPreviewDirectoryReady || !MEDIA_PREVIEW_DIR) {
			return;
		}
		try {
			const info = await FileSystem.getInfoAsync(MEDIA_PREVIEW_DIR);
			if (!info.exists) {
				await FileSystem.makeDirectoryAsync(MEDIA_PREVIEW_DIR, { intermediates: true });
			}
			this.mediaPreviewDirectoryReady = true;
		} catch (error) {
			logger.warn('Failed to ensure media preview directory', error);
		}
	}

	private async ensureMediaPreviewIndex(): Promise<void> {
		if (this.mediaPreviewIndexLoaded) {
			return;
		}
		this.mediaPreviewIndexLoaded = true;
		try {
			const raw = await AsyncStorage.getItem(MEDIA_PREVIEW_INDEX_KEY);
			this.mediaPreviewIndex = raw ? (JSON.parse(raw) as MediaIndex) : {};
		} catch (error) {
			logger.warn('Failed to load media preview index', error);
			this.mediaPreviewIndex = {};
		}

		await this.cleanupMediaPreviewIndex();
	}

	private async rememberMediaPreview(previewKey: string, localUri: string): Promise<void> {
		if (!this.mediaPreviewIndex) {
			this.mediaPreviewIndex = {};
		}
		this.mediaPreviewIndex[previewKey] = { uri: localUri, updatedAt: Date.now() };
		try {
			await AsyncStorage.setItem(MEDIA_PREVIEW_INDEX_KEY, JSON.stringify(this.mediaPreviewIndex));
		} catch (error) {
			logger.warn('Failed to update media preview index', { previewKey, error });
		}
	}

	private async queueDownload(
		remoteUrl: string,
		fileName?: string,
		signal?: AbortSignal,
		priority: DownloadPriority = 'normal'
	): Promise<string> {
		await this.ensureConcurrencyProfile();
		const existing = this.downloadPromises.get(remoteUrl);
		if (existing) {
			const tracked = this.downloadTasks.get(remoteUrl);
			if (tracked) {
				tracked.priority = Math.min(tracked.priority, DOWNLOAD_PRIORITY[priority]);
				if (tracked.priorityLabel === 'low' && priority !== 'low') {
					tracked.priorityLabel = priority;
				}
				this.sortDownloadQueue();
			}
			return await this.awaitWithAbort(existing, signal);
		}

		const deferred = this.createDeferred<string>();
		const task: DownloadTask = {
			remoteUrl,
			fileName,
			priority: DOWNLOAD_PRIORITY[priority],
			priorityLabel: priority,
			resolve: deferred.resolve,
			reject: deferred.reject,
			promise: deferred.promise,
		};

		this.downloadPromises.set(remoteUrl, deferred.promise);
		this.downloadTasks.set(remoteUrl, task);
		this.downloadQueue.push(task);
		this.sortDownloadQueue();
		this.scheduleDownloadDrain(priority);

		return await this.awaitWithAbort(deferred.promise, signal);
	}

	private sortDownloadQueue(): void {
		if (this.downloadQueue.length <= 1) {
			return;
		}
		this.downloadQueue.sort((a, b) => a.priority - b.priority);
	}

	private scheduleDownloadDrain(priority: DownloadPriority): void {
		if (priority === 'low') {
			if (!this.lowPriorityDrainTimer) {
				this.lowPriorityDrainTimer = setTimeout(() => {
					this.lowPriorityDrainTimer = null;
					this.drainDownloadQueue();
				}, LOW_PRIORITY_IDLE_DELAY_MS);
			}
			return;
		}
		this.drainDownloadQueue();
	}

	private drainDownloadQueue(): void {
		const maxConcurrent = this.concurrencyProfile?.downloads ?? 2;
		while (this.activeDownloadCount < maxConcurrent && this.downloadQueue.length > 0) {
			const task = this.downloadQueue.shift();
			if (!task) {
				break;
			}
			if (task.aborted) {
				this.cleanupDownloadTask(task);
				continue;
			}
			this.activeDownloadCount += 1;
			this.runDownloadTask(task)
				.catch((error) => {
					logger.debug('Download task failed', { remoteUrl: task.remoteUrl, error });
				})
				.finally(() => {
					this.activeDownloadCount = Math.max(0, this.activeDownloadCount - 1);
					this.drainDownloadQueue();
				});
		}
	}

	private async runDownloadTask(task: DownloadTask): Promise<void> {
		try {
			const localUri = await this.downloadMedia(task.remoteUrl, task.fileName);
			if (localUri && localUri.startsWith('file://')) {
				await this.rememberMedia(task.remoteUrl, localUri);
			}
			task.resolve(localUri);
		} catch (error) {
			task.reject(error);
		} finally {
			this.cleanupDownloadTask(task);
		}
	}

	private cleanupDownloadTask(task: DownloadTask): void {
		this.downloadTasks.delete(task.remoteUrl);
		this.downloadPromises.delete(task.remoteUrl);
	}

	private async downloadMedia(remoteUrl: string, fileName?: string, signal?: AbortSignal): Promise<string> {
		if (!MEDIA_DIR) return remoteUrl;
		await this.ensureMediaDirectory();

		try {
			const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, remoteUrl);
			const ext = this.inferFileExtension(fileName, remoteUrl);
			const targetPath = `${MEDIA_DIR}/${hash}${ext ? `.${ext}` : ''}`;

			const existing = await FileSystem.getInfoAsync(targetPath);
			if (existing.exists) {
				return existing.uri;
			}

			const download = FileSystem.createDownloadResumable(remoteUrl, targetPath);
			let aborted = false;
			const handleAbort = () => {
				aborted = true;
				download.pauseAsync().catch(() => undefined);
			};
			signal?.addEventListener?.('abort', handleAbort as any, { once: true });
			try {
				const result = await download.downloadAsync();
				if (!result) {
					throw new Error('Download failed without result');
				}
				if (result.status !== 200) {
					throw new Error(`Download failed with status ${result.status}`);
				}
				if (signal?.aborted) {
					throw this.createAbortError();
				}
				return result.uri;
			} finally {
				signal?.removeEventListener?.('abort', handleAbort as any);
				if (aborted) {
					await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => undefined);
				}
			}
		} catch (error) {
			logger.debug('Failed to download media asset', { remoteUrl, error });
			throw error;
		}
	}

	private inferFileExtension(fileName?: string, remoteUrl?: string): string | null {
		const fromName = fileName?.split('.').pop();
		if (fromName && fromName.length <= 6) {
			return fromName.replace(/[^a-zA-Z0-9]/g, '') || null;
		}
		if (remoteUrl) {
			const cleanUrl = remoteUrl.split('?')[0].split('#')[0];
			const parts = cleanUrl.split('.');
			const ext = parts.pop();
			if (ext && ext.length <= 6) {
				return ext.replace(/[^a-zA-Z0-9]/g, '') || null;
			}
		}
		return null;
	}

	private async fileExists(uri: string): Promise<boolean> {
		try {
			const info = await FileSystem.getInfoAsync(uri);
			return info.exists;
		} catch {
			return false;
		}
	}

	private async cleanupMediaIndex(): Promise<void> {
		if (!this.mediaIndex || !MEDIA_DIR) return;
		const now = Date.now();
		if (now - this.lastCleanup < 30_000) {
			return;
		}
		this.lastCleanup = now;

		const entries = Object.entries(this.mediaIndex);
		const removals: string[] = [];

		await Promise.all(
			entries.map(async ([remoteUrl, entry]) => {
				const isExpired = now - entry.updatedAt > MEDIA_TTL_MS;
				const exists = await this.fileExists(entry.uri);
				if (!exists || isExpired) {
					removals.push(remoteUrl);
					if (exists) {
						try {
							await FileSystem.deleteAsync(entry.uri, { idempotent: true });
						} catch (error) {
							logger.debug('Failed to delete stale media file', { uri: entry.uri, error });
						}
					}
				}
			})
		);

		if (removals.length) {
			removals.forEach((remoteUrl) => delete this.mediaIndex![remoteUrl]);
			try {
				await AsyncStorage.setItem(MEDIA_INDEX_KEY, JSON.stringify(this.mediaIndex));
			} catch (error) {
				logger.warn('Failed to persist media index cleanup', error);
			}
		}
	}

	private async cleanupMediaPreviewIndex(): Promise<void> {
		if (!this.mediaPreviewIndex || !MEDIA_PREVIEW_DIR) {
			return;
		}
		const now = Date.now();
		if (now - this.lastPreviewCleanup < 30_000) {
			return;
		}
		this.lastPreviewCleanup = now;

		const entries = Object.entries(this.mediaPreviewIndex);
		const removals: string[] = [];

		await Promise.all(
			entries.map(async ([previewKey, entry]) => {
				const isExpired = now - entry.updatedAt > MEDIA_PREVIEW_FILE_TTL_MS;
				const exists = await this.fileExists(entry.uri);
				if (!exists || isExpired) {
					removals.push(previewKey);
					if (exists) {
						try {
							await FileSystem.deleteAsync(entry.uri, { idempotent: true });
						} catch (error) {
							logger.debug('Failed to delete stale preview file', { uri: entry.uri, error });
						}
					}
				}
			})
		);

		if (removals.length) {
			removals.forEach((previewKey) => delete this.mediaPreviewIndex![previewKey]);
			try {
				await AsyncStorage.setItem(MEDIA_PREVIEW_INDEX_KEY, JSON.stringify(this.mediaPreviewIndex));
			} catch (error) {
				logger.warn('Failed to persist media preview index cleanup', error);
			}
		}
	}

	async clearAllMediaCaches(): Promise<{
		mediaFilesDeleted: number;
		previewFilesDeleted: number;
		bytesFreed: number;
	}> {
		const clearDirectory = async (dir: string | null, ensureDir: () => Promise<void>): Promise<{
			filesDeleted: number;
			bytesFreed: number;
		}> => {
			if (!dir) {
				return { filesDeleted: 0, bytesFreed: 0 };
			}
			await ensureDir();
			try {
				const entries = await FileSystem.readDirectoryAsync(dir);
				let filesDeleted = 0;
				let bytesFreed = 0;
				for (const entry of entries) {
					const targetPath = `${dir.replace(/\/$/, '')}/${entry}`;
					try {
						const info = await FileSystem.getInfoAsync(targetPath, { size: true });
						if (info.exists) {
							bytesFreed += typeof info.size === 'number' ? info.size : 0;
							await FileSystem.deleteAsync(targetPath, { idempotent: true });
							filesDeleted += 1;
						}
					} catch (error) {
						logger.debug('Failed to delete cached media file', { targetPath, error });
					}
				}
				return { filesDeleted, bytesFreed };
			} catch (error) {
				logger.debug('Failed to enumerate cache directory', { dir, error });
				return { filesDeleted: 0, bytesFreed: 0 };
			}
		};

		const mediaResult = await clearDirectory(MEDIA_DIR, () => this.ensureMediaDirectory());
		const previewResult = await clearDirectory(MEDIA_PREVIEW_DIR, () => this.ensureMediaPreviewDirectory());

		this.mediaIndex = {};
		this.mediaPreviewIndex = {};
		this.mediaIndexLoaded = false;
		this.mediaPreviewIndexLoaded = false;
		this.mediaDirectoryReady = false;
		this.mediaPreviewDirectoryReady = false;
		await AsyncStorage.multiRemove([MEDIA_INDEX_KEY, MEDIA_PREVIEW_INDEX_KEY]).catch(() => undefined);

		return {
			mediaFilesDeleted: mediaResult.filesDeleted,
			previewFilesDeleted: previewResult.filesDeleted,
			bytesFreed: mediaResult.bytesFreed + previewResult.bytesFreed,
		};
	}
}

export const chatCacheService = new ChatCacheService();
