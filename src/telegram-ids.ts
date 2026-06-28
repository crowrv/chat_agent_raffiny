export function telegramIntegerId(value: string | undefined): number | undefined {
  if (!value || !/^-?\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}
