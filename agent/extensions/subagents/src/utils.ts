export { formatDuration, truncLine } from "../../shared/text-format.js";

export function formatTokens(n: number): string {
    return n < 1000
        ? String(n)
        : n < 10000
          ? `${(n / 1000).toFixed(1)}k`
          : `${Math.round(n / 1000)}k`;
}

export function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return ((...args: any[]) => {
        const now = Date.now();
        const remaining = ms - (now - lastCall);
        if (remaining <= 0) {
            lastCall = now;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            fn(...args);
        } else if (!timer) {
            timer = setTimeout(() => {
                lastCall = Date.now();
                timer = undefined;
                fn(...args);
            }, remaining);
        }
    }) as T;
}

export async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i], i);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
