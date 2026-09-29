export function formatRetryAfter(retryAfter: number): string {
  if (retryAfter < 60) {
    return `Please wait ${retryAfter} seconds`;
  }

  const minutes = Math.ceil(retryAfter / 60);
  return `Please wait ${minutes} minutes`;
}
