/**
 * Global registry for stress-test instances.
 *
 * Instances are Fisher-Yates shuffled and a random subset is registered.
 */
const globalRegistry = [];
export function registerInstances(instances, subsetRatio = 0.7) {
    const shuffled = [...instances];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const count = Math.max(1, Math.floor(shuffled.length * subsetRatio));
    const subset = shuffled.slice(0, count);
    globalRegistry.push(...subset);
    return subset.length;
}
export function pickRandom() {
    if (globalRegistry.length === 0)
        return undefined;
    const idx = Math.floor(Math.random() * globalRegistry.length);
    return globalRegistry.splice(idx, 1)[0];
}
export function registrySize() {
    return globalRegistry.length;
}
export function clearRegistry() {
    globalRegistry.length = 0;
}
//# sourceMappingURL=registry.js.map