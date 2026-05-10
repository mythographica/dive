/**
 * Dead Letter Queue for the dive stress test.
 *
 * Collects failed instances from uncaughtException and unhandledRejection.
 * Produces a comprehensive report when threshold is reached.
 */
import { getLastContext } from '../index.js';
import { getProps } from 'mnemonica';
const DLQ = [];
export function getDlqSize() {
    return DLQ.length;
}
export function clearDlq() {
    DLQ.length = 0;
}
export function getDlqEntries() {
    return DLQ;
}
function getInstanceTypeName(instance) {
    try {
        const p = getProps(instance);
        return p?.__type__?.TypeName ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function getDiveContextName() {
    const ctx = getLastContext();
    if (!ctx)
        return null;
    return getInstanceTypeName(ctx);
}
export function produceReport() {
    const byRequest = new Map();
    const byType = new Map();
    const samples = [];
    for (const item of DLQ) {
        byRequest.set(item.requestId, (byRequest.get(item.requestId) || 0) + 1);
        byType.set(item.errorType, (byType.get(item.errorType) || 0) + 1);
        if (samples.length < 5) {
            samples.push(`${item.requestId}/${item.uuid}`);
        }
    }
    return {
        total: DLQ.length,
        byType: Object.fromEntries(byType),
        byRequest: Object.fromEntries(byRequest),
        samples,
    };
}
export function pushToDlq(params) {
    DLQ.push({
        requestId: params.requestId,
        uuid: params.uuid,
        instance: params.instance,
        errorType: params.errorType,
        timestamp: Date.now(),
        diveContext: getDiveContextName(),
    });
}
//# sourceMappingURL=dlq.js.map