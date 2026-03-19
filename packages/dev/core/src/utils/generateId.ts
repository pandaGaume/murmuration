/**
 * Generate a simple unique id.
 */
export function generateId(prefix = "id"): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
