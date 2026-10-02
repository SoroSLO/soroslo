interface DecimalValue {
  coefficient: bigint;
  scale: number;
}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_DIGITS = 1_000;
const MAX_EXPONENT = 1_000;

function parseDecimalText(text: string): DecimalValue {
  const match = DECIMAL_RE.exec(text.trim());
  if (!match) throw new TypeError(`Not an exact numeric value: ${text}`);

  const integerPart = match[2] ?? "";
  const fractionPart = match[3] ?? "";
  if (integerPart.length + fractionPart.length > MAX_DIGITS) {
    throw new RangeError("Numeric value is too large to compare safely");
  }

  const exponent = Number(match[4] ?? "0");
  if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new RangeError("Numeric exponent is outside the supported range");
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const digits = (integerPart + fractionPart).replace(/^0+(?=\d)/, "") || "0";
  let coefficient = sign * BigInt(digits);
  let scale = fractionPart.length - exponent;

  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }

  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }

  return { coefficient, scale };
}

function parseExactNumber(value: unknown): DecimalValue {
  if (typeof value === "bigint") return { coefficient: value, scale: 0 };

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number cannot be compared");
    return parseDecimalText(value.toString());
  }

  if (typeof value === "string") return parseDecimalText(value);

  throw new TypeError(`Expected numeric value, received ${typeof value}`);
}

export function compareExactNumeric(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = parseExactNumber(left);
  const b = parseExactNumber(right);
  const scale = Math.max(a.scale, b.scale);
  const leftCoefficient = a.coefficient * 10n ** BigInt(scale - a.scale);
  const rightCoefficient = b.coefficient * 10n ** BigInt(scale - b.scale);

  if (leftCoefficient < rightCoefficient) return -1;
  if (leftCoefficient > rightCoefficient) return 1;
  return 0;
}
