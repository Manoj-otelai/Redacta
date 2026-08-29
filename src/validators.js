export function digitsOnly(value) {
  return String(value).replace(/\D/g, "");
}

export function isLuhnValid(value) {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export function isStructurallyValidSsn(value) {
  const match = String(value).match(/^(\d{3})[- ](\d{2})[- ](\d{4})$/);
  if (!match) return false;
  const [, area, group, serial] = match;
  return !area.startsWith("000") && !area.startsWith("666") && !area.startsWith("9")
    && group !== "00" && serial !== "0000";
}

export function hasApiKeyShape(value) {
  return /^(?:sk_(?:live|test)|sk|pk_(?:live|test)|gh[pousr]_|AKIA)[A-Za-z0-9_-]{8,}$/i.test(String(value));
}

export function hasBearerTokenShape(value) {
  return /^Bearer\s+[A-Za-z0-9._~+/=-]{20,}$/i.test(String(value));
}

export function hasPrivateKeyShape(value) {
  return /^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]+ PRIVATE KEY-----$/.test(String(value));
}

export function hasDbConnectionShape(value) {
  return /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+(?::[^/\s]*)?@[^/\s]+(?:\/[^\s]*)?$/i.test(String(value));
}

export function isEmailShape(value) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(String(value));
}

export function isPhoneShape(value) {
  const digits = digitsOnly(value);
  return digits.length === 10 && !/^0{3}/.test(digits) && !/^1{3}/.test(digits);
}

export function validateCandidate(type, value) {
  switch (type) {
    case "ssn": return isStructurallyValidSsn(value);
    case "credit_card": return isLuhnValid(value);
    case "email": return isEmailShape(value);
    case "phone": return isPhoneShape(value);
    case "api_key": return hasApiKeyShape(value);
    case "private_key": return hasPrivateKeyShape(value);
    case "bearer_token": return hasBearerTokenShape(value);
    case "db_connection_string": return hasDbConnectionShape(value);
    default: return false;
  }
}
