export type ErrorType = 'sync-throw' | 'unhandled-rejection' | 'creation-error';
export interface FailedInstance {
    requestId: string;
    uuid: string;
    instance: object;
    errorType: ErrorType;
    timestamp: number;
    diveContext: string | null;
}
export declare function getDlqSize(): number;
export declare function clearDlq(): void;
export declare function getDlqEntries(): readonly FailedInstance[];
export interface DlqReport {
    total: number;
    byType: Record<ErrorType, number>;
    byRequest: Record<string, number>;
    samples: string[];
}
export declare function produceReport(): DlqReport;
export declare function pushToDlq(params: {
    requestId: string;
    uuid: string;
    instance: object;
    errorType: ErrorType;
}): void;
//# sourceMappingURL=dlq.d.ts.map