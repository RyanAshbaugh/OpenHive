import { nanoid } from 'nanoid';

export function generateId(size = 12): string {
  return nanoid(size);
}

export function generateShortId(): string {
  return nanoid(8);
}
