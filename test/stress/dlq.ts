/**
 * Dead Letter Queue for the dive stress test.
 *
 * Collects failures. Every entry is derived FROM THE ERROR ITSELF:
 * the origin instance (getErrorInstance) and the execution branch that
 * produced the failure (getFlow) — no side maps, no manual linking.
 * Produces a comprehensive report when threshold is reached.
 */
import { getErrorInstance, getFlow } from '../../src/index.js';

export type ErrorType = 'sync-throw' | 'unhandled-rejection' | 'creation-error';

export interface FailedInstance {
	requestId   : string;
	uuid        : string;
	instance    : object | undefined;
	errorType   : ErrorType;
	timestamp   : number;
	flowLength  : number;
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
	error     : Error;
	errorType : ErrorType;
}) : void {
	// The Goal: the error carries the data and the flow. Everything the DLQ
	// needs is recovered off the error object — requestId and uuid live in
	// the instance's own data, the branch length proves the trace survived.
	const instance = getErrorInstance(params.error) as Record<string, unknown> | undefined;
	DLQ.push({
		requestId  : String(instance?.requestId ?? 'unknown'),
		uuid       : String(instance?.uuid ?? 'unknown'),
		instance,
		errorType  : params.errorType,
		timestamp  : Date.now(),
		flowLength : getFlow(params.error).length,
	});
}
