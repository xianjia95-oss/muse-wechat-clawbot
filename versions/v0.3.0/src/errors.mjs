export class BridgeError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const fail = (code, message, status = 400, details) => {
  throw new BridgeError(code, message, status, details);
};

export function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) fail('invalid_argument', `${name} must be ${min}..${max}`);
  return value;
}

export function duration(value, fallback) {
  if (value === undefined) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(value));
  if (!match) fail('invalid_argument', 'Duration must have a unit: ms, s, m, h');
  return Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]];
}
