export interface TimestampCarrier {
	timestamp?: string | null;
}

export interface RangeBounds {
	startTimestamp?: string | null;
	endTimestamp?: string | null;
}

export type PinRange = RangeBounds;

export const safeTimestamp = (value?: string | null): number | null => {
	if (!value) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};

export const clampRange = (range: RangeBounds | null | undefined): RangeBounds | null => {
	if (!range) {
		return null;
	}
	const start = safeTimestamp(range.startTimestamp);
	const end = safeTimestamp(range.endTimestamp);
	if (start == null && end == null) {
		return null;
	}
	if (start != null && end != null && start > end) {
		return {
			startTimestamp: range.endTimestamp ?? range.startTimestamp ?? null,
			endTimestamp: range.startTimestamp ?? range.endTimestamp ?? null,
		};
	}
	return {
		startTimestamp: range.startTimestamp ?? range.endTimestamp ?? null,
		endTimestamp: range.endTimestamp ?? range.startTimestamp ?? null,
	};
};

export const rangesOverlap = (
	rangeA: RangeBounds | null | undefined,
	rangeB: RangeBounds | null | undefined
): boolean => {
	const normalizedA = clampRange(rangeA);
	const normalizedB = clampRange(rangeB);
	if (!normalizedA || !normalizedB) {
		return true;
	}
	const aStart = safeTimestamp(normalizedA.startTimestamp) ?? Number.NEGATIVE_INFINITY;
	const aEnd = safeTimestamp(normalizedA.endTimestamp) ?? Number.POSITIVE_INFINITY;
	const bStart = safeTimestamp(normalizedB.startTimestamp) ?? Number.NEGATIVE_INFINITY;
	const bEnd = safeTimestamp(normalizedB.endTimestamp) ?? Number.POSITIVE_INFINITY;
	return aStart <= bEnd && bStart <= aEnd;
};

export const partitionMessagesByLimit = <T extends TimestampCarrier>(
	messages: T[],
	limit: number
): { retained: T[]; spilled: T[] } => {
	const effectiveLimit = Math.max(1, Math.floor(limit));
	if (messages.length <= effectiveLimit) {
		return { retained: messages.slice(), spilled: [] };
	}
	const overflow = messages.length - effectiveLimit;
	return {
		retained: messages.slice(-effectiveLimit),
		spilled: messages.slice(0, overflow),
	};
};

export const deriveRangeFromMessages = <T extends TimestampCarrier>(messages: T[]): RangeBounds | null => {
	if (!Array.isArray(messages) || !messages.length) {
		return null;
	}
	let minTs: number | null = null;
	let maxTs: number | null = null;
	let minValue: string | null = null;
	let maxValue: string | null = null;

	for (const message of messages) {
		const ts = safeTimestamp(message.timestamp);
		if (ts == null) {
			continue;
		}
		if (minTs == null || ts < minTs) {
			minTs = ts;
			minValue = message.timestamp ?? null;
		}
		if (maxTs == null || ts > maxTs) {
			maxTs = ts;
			maxValue = message.timestamp ?? null;
		}
	}

	if (minValue == null && maxValue == null) {
		return null;
	}

	return {
		startTimestamp: minValue ?? maxValue,
		endTimestamp: maxValue ?? minValue,
	};
};
