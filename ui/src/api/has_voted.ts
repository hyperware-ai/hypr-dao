const API_PREFIX =
  typeof window !== 'undefined' && window.location.pathname.includes('hypr-dao:hypr-dao:ware.hypr')
    ? '/hypr-dao:hypr-dao:ware.hypr'
    : '';

function parseResponse<T>(json: any): T {
  if (json && Object.prototype.hasOwnProperty.call(json, 'Ok')) {
    return json.Ok as T;
  }
  if (json && Object.prototype.hasOwnProperty.call(json, 'Err')) {
    throw new Error(String(json.Err));
  }
  throw new Error('Unexpected response shape from API');
}

export async function fetchHasVoted(proposalId: string, voter: string): Promise<boolean> {
  const response = await fetch(`${API_PREFIX}/api/has-voted`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ HasVoted: [proposalId, voter] }),
  });
  if (!response.ok) {
    throw new Error(`Failed to check vote status (status ${response.status})`);
  }
  const json = await response.json();
  return parseResponse<boolean>(json);
}
