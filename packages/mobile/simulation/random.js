/**
 * Seeded random utilities for reproducible simulation data.
 *
 * Uses a linear congruential generator (Park-Miller) seeded from
 * a date string hash, so the same date always produces the same
 * sequence of random values.
 */

/**
 * Create a seeded random number generator.
 * Returns a function that produces values in [0, 1) on each call.
 */
export function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Produce a numeric seed from a date.
 * @param {Date|string} date
 * @param {function} localYMD - converts Date → 'YYYY-MM-DD' string
 */
export function dateSeed(date, localYMD) {
  const d = typeof date === 'string' ? date : localYMD(date);
  let h = 0;
  for (let i = 0; i < d.length; i++) {
    h = (h * 31 + d.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
