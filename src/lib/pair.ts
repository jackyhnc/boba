// Helpers for the userAId < userBId invariant used by DailyMatch and
// RematchHistory. Centralising avoids subtle ordering bugs in callers.

export interface OrderedPair {
  userAId: string;
  userBId: string;
}

/** Sort two user ids into the canonical (A, B) order with A < B. */
export function orderPair(x: string, y: string): OrderedPair {
  if (x === y) {
    throw new Error(`orderPair: cannot pair a user with themselves (${x})`);
  }
  return x < y ? { userAId: x, userBId: y } : { userAId: y, userBId: x };
}

/** True if (a, b) is already in canonical order. */
export function isOrderedPair(a: string, b: string): boolean {
  return a < b;
}
