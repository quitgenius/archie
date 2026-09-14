// A microVM can boot before the user changes models and receive its first turn afterwards.
// The first fingerprint read therefore must re-bind too; it cannot bless the boot-time config.
export async function refreshSessionConfig(current, fingerprint, reload) {
  if (!fingerprint || fingerprint === current.fp) return { state: current };
  const info = await reload(); // Failure leaves the old fingerprint intact and aborts this turn.
  return { state: { fp: fingerprint }, info };
}
