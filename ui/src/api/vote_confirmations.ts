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

export async function fetchConfirmedVotes(voter: string): Promise<string[]> {
  const response = await fetch(`${API_PREFIX}/api/get-vote-confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ GetVoteConfirmations: voter }),
  });
  if (!response.ok) {
    throw new Error(`Failed to load vote confirmations (status ${response.status})`);
  }
  const json = await response.json();
  return parseResponse<string[]>(json);
}

export async function recordVoteConfirmation(proposalId: string, voter: string): Promise<void> {
  const response = await fetch(`${API_PREFIX}/api/record-vote-confirmation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ RecordVoteConfirmation: [proposalId, voter] }),
  });
  if (!response.ok) {
    throw new Error(`Failed to record vote confirmation (status ${response.status})`);
  }
  const json = await response.json();
  parseResponse<null>(json);
}
