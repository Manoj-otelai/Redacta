export function confidenceScore({ candidate = true, validated = false, type }) {
  if (!candidate) return 0;
  const baseline = {
    ssn: 0.56, credit_card: 0.54, email: 0.58, phone: 0.55,
    api_key: 0.57, private_key: 0.62, bearer_token: 0.57, db_connection_string: 0.6,
  }[type] ?? 0.5;
  return Number(Math.min(1, baseline + (validated ? 0.4 : 0)).toFixed(2));
}
