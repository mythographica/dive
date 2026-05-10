/**
 * Dead Letter Queue for the dive stress test.
 *
 * Collects failed instances from uncaughtException and unhandledRejection.
 * Produces a comprehensive report when threshold is reached.
 */
import { getLastContext } from '../index.js';
import { getProps } from 'mnemonica';

export type ErrorType = 'sync-throw' | 'unhandled-rejection' | 'creation-error';

export interface FailedInstance {
	requestId   : string;
	uuid        : string;
	instance    : object;
	errorType   : ErrorType;
	timestamp   : number;
	diveContext : string | null;
}

const DLQ : FailedInstance[] = [];

export function getDlqSize () : number {
	return DLQ.length;
}

export function clearDlq () : void {
	DLQ.length = 0;
}

export function getDlqEntries () : readonly FailedInstance[] {
	return DLQ;
}

function getInstanceTypeName (instance : object) : string {
	try {
		const p = getProps(instance);
		return p?.__type__?.TypeName ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

function getDiveContextName () : string | null {
	const ctx = getLastContext();
	if (!ctx) return null;
	return getInstanceTypeName(ctx);
}

export interface DlqReport {
	total      : number;
	byType     : Record<ErrorType, number>;
	byRequest  : Record<string, number>;
	samples    : string[];
}

export function produceReport () : DlqReport {
	const byRequest = new Map<string, number>();
	const byType = new Map<ErrorType, number>();
	const samples : string[] = [];

	for (const item of DLQ) {
		byRequest.set(item.requestId, (byRequest.get(item.requestId) || 0) + 1);
		byType.set(item.errorType, (byType.get(item.errorType) || 0) + 1);
		if (samples.length < 5) {
			samples.push(`${item.requestId}/${item.uuid}`);
		}
	}

	return {
		total     : DLQ.length,
		byType    : Object.fromEntries(byType) as Record<ErrorType, number>,
		byRequest : Object.fromEntries(byRequest),
		samples,
	};
}

export function pushToDlq (params: {
	requestId : string;
	uuid      : string;
	instance  : object;
	errorType : ErrorType;
}) : void {
	DLQ.push({
		requestId   : params.requestId,
		uuid        : params.uuid,
		instance    : params.instance,
		errorType   : params.errorType,
		timestamp   : Date.now(),
		diveContext : getDiveContextName(),
	});
}
